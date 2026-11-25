import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  initQueues,
  type InitializedQueues,
} from "../../infra/sqs/init-queues.ts";
import { loadEnv } from "../../src/shared/infrastructure/config/env.ts";

describe("Contrato SQS FIFO + RedrivePolicy (MiniStack)", () => {
  const env = loadEnv();
  let sqs: SQSClient;
  let queues: InitializedQueues;

  beforeAll(async () => {
    sqs = new SQSClient({
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
    queues = await initQueues(sqs);
  });

  afterAll(() => {
    sqs?.destroy();
  });

  test("SQS FIFO (wager-transactions.fifo e wagering-events.fifo) envia, recebe e faz ack", async () => {
    const dedupId = Bun.randomUUIDv7();
    const payload = JSON.stringify({ probe: dedupId });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        MessageBody: payload,
        MessageGroupId: `group-${dedupId}`,
        MessageDeduplicationId: dedupId,
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    const msg = received.Messages?.[0];
    expect(msg).toBeDefined();
    expect(msg?.Body).toBe(payload);
    expect(msg?.Attributes?.ApproximateReceiveCount).toBe("1");

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        ReceiptHandle: msg!.ReceiptHandle!,
      }),
    );

    const eventId = Bun.randomUUIDv7();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.eventsQueueUrl,
        MessageBody: JSON.stringify({ eventId }),
        MessageGroupId: "wallet-spike",
        MessageDeduplicationId: eventId,
      }),
    );

    const eventRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventsQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );
    const eventMsg = eventRes.Messages?.[0];
    expect(eventMsg?.Body).toBe(JSON.stringify({ eventId }));
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queues.eventsQueueUrl,
        ReceiptHandle: eventMsg!.ReceiptHandle!,
      }),
    );
  });

  test("ChangeMessageVisibility, ApproximateReceiveCount e RedrivePolicy para DLQ", async () => {
    const suffix = Bun.randomUUIDv7().slice(-8);
    const dlqName = `contract-dlq-${suffix}.fifo`;
    const mainName = `contract-main-${suffix}.fifo`;

    const dlqRes = await sqs.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
    const dlqUrl = dlqRes.QueueUrl!;
    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const dlqArn = dlqAttrs.Attributes!.QueueArn!;

    const mainRes = await sqs.send(
      new CreateQueueCommand({
        QueueName: mainName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: 2,
          }),
        },
      }),
    );
    const mainUrl = mainRes.QueueUrl!;

    try {
      const msgId = Bun.randomUUIDv7();
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: mainUrl,
          MessageBody: JSON.stringify({ msgId }),
          MessageGroupId: "redrive-group",
          MessageDeduplicationId: msgId,
        }),
      );

      const r1 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      expect(r1.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe("1");

      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: mainUrl,
          ReceiptHandle: r1.Messages![0]!.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );

      const r2 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      expect(r2.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe("2");

      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: mainUrl,
          ReceiptHandle: r2.Messages![0]!.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );

      const r3 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      expect(r3.Messages ?? []).toHaveLength(0);

      const dlqRecv = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
        }),
      );
      expect(dlqRecv.Messages?.[0]?.Body).toBe(JSON.stringify({ msgId }));
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: mainUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    }
  });
});

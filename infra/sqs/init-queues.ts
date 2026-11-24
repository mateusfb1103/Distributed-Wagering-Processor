import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const region = process.env.AWS_REGION ?? "us-east-1";
const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "000000000000";
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "test";

const wagerQueueName =
  process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo";
const wagerDlqName =
  process.env.SQS_WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo";
const eventsQueueName =
  process.env.SQS_EVENTS_QUEUE_NAME ?? "wagering-events.fifo";
const maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? "5");

export interface InitializedQueues {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  wagerDlqArn: string;
  eventsQueueUrl: string;
}

export async function initQueues(client?: SQSClient): Promise<InitializedQueues> {
  const sqs =
    client ??
    new SQSClient({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });

  const dlqRes = await sqs.send(
    new CreateQueueCommand({
      QueueName: wagerDlqName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );
  const wagerDlqUrl = dlqRes.QueueUrl;
  if (!wagerDlqUrl) {
    throw new Error(`Failed to create DLQ ${wagerDlqName}`);
  }

  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: wagerDlqUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  const wagerDlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!wagerDlqArn) {
    throw new Error(`Failed to resolve QueueArn for ${wagerDlqName}`);
  }

  const mainRes = await sqs.send(
    new CreateQueueCommand({
      QueueName: wagerQueueName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: wagerDlqArn,
          maxReceiveCount,
        }),
      },
    }),
  );
  const wagerQueueUrl = mainRes.QueueUrl;
  if (!wagerQueueUrl) {
    throw new Error(`Failed to create main queue ${wagerQueueName}`);
  }

  const eventsRes = await sqs.send(
    new CreateQueueCommand({
      QueueName: eventsQueueName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );
  const eventsQueueUrl = eventsRes.QueueUrl;
  if (!eventsQueueUrl) {
    throw new Error(`Failed to create events queue ${eventsQueueName}`);
  }

  return { wagerQueueUrl, wagerDlqUrl, wagerDlqArn, eventsQueueUrl };
}

if (import.meta.main) {
  const result = await initQueues();
  console.log(JSON.stringify({ msg: "SQS queues initialized", ...result }));
}

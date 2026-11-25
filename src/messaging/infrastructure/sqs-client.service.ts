import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { loadEnv } from "../../shared/infrastructure/config/env.ts";

export interface QueueUrls {
  readonly wagerQueueUrl: string;
  readonly wagerDlqUrl: string;
  readonly eventsQueueUrl: string;
}

const SQS_PUBLISH_TIMEOUT_MS = 5000;

@Injectable()
export class SqsClientService implements OnModuleDestroy {
  readonly client: SQSClient;
  private cachedUrls: QueueUrls | null = null;

  constructor() {
    const env = loadEnv();
    this.client = new SQSClient({
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async getQueueUrls(): Promise<QueueUrls> {
    if (this.cachedUrls) {
      return this.cachedUrls;
    }

    const env = loadEnv();
    const [wagerRes, dlqRes, eventsRes] = await Promise.all([
      this.client.send(
        new GetQueueUrlCommand({ QueueName: env.SQS_WAGER_QUEUE_NAME }),
        { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
      ),
      this.client.send(
        new GetQueueUrlCommand({ QueueName: env.SQS_WAGER_DLQ_NAME }),
        { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
      ),
      this.client.send(
        new GetQueueUrlCommand({ QueueName: env.SQS_EVENTS_QUEUE_NAME }),
        { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
      ),
    ]);

    if (!wagerRes.QueueUrl || !dlqRes.QueueUrl || !eventsRes.QueueUrl) {
      throw new Error("Failed to resolve required SQS queue URLs.");
    }

    this.cachedUrls = {
      wagerQueueUrl: wagerRes.QueueUrl,
      wagerDlqUrl: dlqRes.QueueUrl,
      eventsQueueUrl: eventsRes.QueueUrl,
    };
    return this.cachedUrls;
  }

  async sendEventMessage(params: {
    readonly messageBody: string;
    readonly messageGroupId: string;
    readonly messageDeduplicationId: string;
    readonly messageAttributes?: Record<string, MessageAttributeValue>;
  }): Promise<void> {
    const { eventsQueueUrl } = await this.getQueueUrls();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: eventsQueueUrl,
        MessageBody: params.messageBody,
        MessageGroupId: params.messageGroupId,
        MessageDeduplicationId: params.messageDeduplicationId,
        MessageAttributes: params.messageAttributes,
      }),
      { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
    );
  }

  async sendToDlq(params: {
    readonly messageBody: string;
    readonly messageGroupId: string;
    readonly messageDeduplicationId: string;
    readonly messageAttributes: Record<string, MessageAttributeValue>;
  }): Promise<void> {
    const { wagerDlqUrl } = await this.getQueueUrls();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: wagerDlqUrl,
        MessageBody: params.messageBody,
        MessageGroupId: params.messageGroupId,
        MessageDeduplicationId: params.messageDeduplicationId,
        MessageAttributes: params.messageAttributes,
      }),
      { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
    );
  }

  async receiveWagerMessages(params: {
    readonly maxNumberOfMessages: number;
    readonly waitTimeSeconds: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<Message[]> {
    const { wagerQueueUrl } = await this.getQueueUrls();
    const timeoutSignal = AbortSignal.timeout(
      (params.waitTimeSeconds + 5) * 1000,
    );
    const signal = params.abortSignal
      ? AbortSignal.any([timeoutSignal, params.abortSignal])
      : timeoutSignal;

    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: wagerQueueUrl,
        MaxNumberOfMessages: params.maxNumberOfMessages,
        WaitTimeSeconds: params.waitTimeSeconds,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
      { abortSignal: signal },
    );
    return res.Messages ?? [];
  }

  async deleteWagerMessage(receiptHandle: string): Promise<void> {
    const { wagerQueueUrl } = await this.getQueueUrls();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
      { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
    );
  }

  async changeWagerMessageVisibility(
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    const { wagerQueueUrl } = await this.getQueueUrls();
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
      { abortSignal: AbortSignal.timeout(SQS_PUBLISH_TIMEOUT_MS) },
    );
  }
}

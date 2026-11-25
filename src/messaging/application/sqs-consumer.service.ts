import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Message } from "@aws-sdk/client-sqs";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { z } from "zod";
import { InboxMessageSchema } from "../../database/entities/inbox-message.entity.ts";
import { ContractViolationError } from "../../shared/domain/domain-error.ts";
import { hashRawMessageBody } from "../../shared/domain/payload-hasher.ts";
import {
  getActiveFaultInjectionPoint,
  loadEnv,
} from "../../shared/infrastructure/config/env.ts";
import { AppLogger } from "../../shared/infrastructure/observability/logger.service.ts";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service.ts";
import { requestContext } from "../../shared/infrastructure/observability/request-context.ts";
import { SubmitWagerTransactionUseCase } from "../../wagering/application/submit-wager-transaction.use-case.ts";
import { SqsClientService } from "../infrastructure/sqs-client.service.ts";
import {
  FaultInjectionError,
  PermanentSqsMessageError,
  classifySqsError,
  computeSqsVisibilityBackoffSeconds,
} from "./sqs-message-classifier.ts";

const CONSUMER_NAME = "wager-transactions-consumer";

const sqsEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    messageId: z.string().min(1).optional(),
    occurredAt: z.string().optional(),
    providerId: z.string().min(1),
    idempotencyKey: z.string().optional(),
    externalTransactionId: z.string().min(1),
    playerId: z.string().min(1),
    walletId: z.string().min(1),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.string().min(1),
    money: z
      .object({
        amount: z.string(),
        currency: z.string(),
      })
      .strict(),
    referenceExternalTransactionId: z.string().nullable().optional(),
  })
  .strict();

export interface SqsPollResult {
  readonly received: number;
  readonly acked: number;
  readonly dlq: number;
  readonly retried: number;
}

/**
 * Consumer SQS FIFO (D10):
 * - Deduplicação de entrega por `inbox_messages` + `payload_hash` na mesma transação do domínio
 * - Classificação híbrida: negócio → ack; permanente → DLQ + delete; transitório → backoff visibilidade + redrive nativo
 * - Graceful shutdown aguardando mensagens em voo até `SHUTDOWN_TIMEOUT_MS` e devolvendo as restantes com visibility 0
 */
@Injectable()
export class SqsConsumerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private running = false;
  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;
  private receiveAbortController: AbortController | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsClientService) private readonly sqs: SqsClientService,
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitWager: SubmitWagerTransactionUseCase,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (env.NODE_ENV === "test") {
      return;
    }
    if (env.APP_ROLES.includes("consumer")) {
      this.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.shuttingDown = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.shuttingDown = true;
    this.receiveAbortController?.abort();

    const timeoutMs = loadEnv().SHUTDOWN_TIMEOUT_MS;
    const waitInFlight = Promise.allSettled(Array.from(this.inFlight));
    await Promise.race([
      waitInFlight,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    if (this.loopPromise) {
      await Promise.race([
        this.loopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      this.loopPromise = null;
    }
  }

  async pollOnce(options?: {
    readonly waitTimeSeconds?: number;
    readonly maxMessages?: number;
    readonly faultInjectionOverride?: string | null;
    readonly abortSignal?: AbortSignal;
  }): Promise<SqsPollResult> {
    const env = loadEnv();
    let messages: Message[];
    try {
      messages = await this.sqs.receiveWagerMessages({
        maxNumberOfMessages: options?.maxMessages ?? env.SQS_MAX_MESSAGES,
        waitTimeSeconds: options?.waitTimeSeconds ?? env.SQS_WAIT_TIME_SECONDS,
        abortSignal: options?.abortSignal,
      });
    } catch (error) {
      if (this.shuttingDown || options?.abortSignal?.aborted) {
        return { received: 0, acked: 0, dlq: 0, retried: 0 };
      }
      throw error;
    }

    let acked = 0;
    let dlq = 0;
    let retried = 0;

    for (const msg of messages) {
      if (this.shuttingDown && msg.ReceiptHandle) {
        await this.sqs.changeWagerMessageVisibility(msg.ReceiptHandle, 0);
        retried += 1;
        continue;
      }

      const task = this.handleMessage(
        msg,
        options?.faultInjectionOverride,
      );
      const tracked = task.then(() => undefined);
      this.inFlight.add(tracked);
      try {
        const outcome = await task;
        if (outcome === "ACK") {
          acked += 1;
        } else if (outcome === "DLQ") {
          dlq += 1;
        } else {
          retried += 1;
        }
      } finally {
        this.inFlight.delete(tracked);
      }
    }

    return {
      received: messages.length,
      acked,
      dlq,
      retried,
    };
  }

  async handleMessage(
    msg: Message,
    faultInjectionOverride?: string | null,
  ): Promise<"ACK" | "DLQ" | "RETRY"> {
    const receiptHandle = msg.ReceiptHandle;
    const rawBody = msg.Body ?? "";
    const sqsMessageId = msg.MessageId ?? Bun.randomUUIDv7();
    const attrCorrelationId =
      msg.MessageAttributes?.correlationId?.StringValue?.trim();
    const correlationId =
      attrCorrelationId && attrCorrelationId.length > 0
        ? attrCorrelationId
        : sqsMessageId;

    return requestContext.run(
      { correlationId, messageId: sqsMessageId },
      async () => {
        const receivedAt = new Date();
        const rawHash = hashRawMessageBody(rawBody);
        const receiveCount = Number(
          msg.Attributes?.ApproximateReceiveCount ?? "1",
        );

        try {
          const parsedJson: unknown = JSON.parse(rawBody);
          const parsedResult = sqsEnvelopeSchema.safeParse(parsedJson);
          if (!parsedResult.success) {
            throw new ContractViolationError(
              "INVALID_PAYLOAD",
              "SQS message failed strict schema validation.",
              {
                issues: parsedResult.error.issues.map((i) => ({
                  path: i.path.join("."),
                  message: i.message,
                })),
              },
            );
          }

          const envelope = parsedResult.data;
          if (
            envelope.type !== undefined &&
            envelope.type !== "WagerTransactionRequested"
          ) {
            throw new PermanentSqsMessageError(
              "UNKNOWN_MESSAGE_TYPE",
              "INVALID_PAYLOAD",
              `Unsupported SQS message type "${envelope.type}".`,
            );
          }

          const effectiveMessageId = envelope.messageId ?? sqsMessageId;
          requestContext.set({ messageId: effectiveMessageId });

          // Checagem prévia na inbox para duplicatas ou payloadHash divergente
          const em = this.orm.em.fork() as EntityManager;
          const existingInbox = await em.findOne(InboxMessageSchema, {
            consumerName: CONSUMER_NAME,
            messageId: effectiveMessageId,
          });

          if (existingInbox) {
            if (existingInbox.payloadHash !== rawHash) {
              throw new PermanentSqsMessageError(
                "INBOX_PAYLOAD_HASH_MISMATCH",
                "IDEMPOTENCY_KEY_CONFLICT",
                `Inbox messageId ${effectiveMessageId} already received with a different payload.`,
              );
            }
            if (existingInbox.status === "PROCESSED") {
              if (receiptHandle) {
                await this.sqs.deleteWagerMessage(receiptHandle);
              }
              this.metrics.sqsMessagesTotal.inc({ outcome: "duplicate_ack" });
              return "ACK";
            }
          }

          const attrIdemKey =
            msg.MessageAttributes?.idempotencyKey?.StringValue?.trim();
          const idempotencyKey =
            envelope.idempotencyKey?.trim() || attrIdemKey || "";

          if (idempotencyKey.length === 0) {
            throw new ContractViolationError(
              "IDEMPOTENCY_KEY_REQUIRED",
              "idempotencyKey is required in SQS message.",
            );
          }

          await this.submitWager.execute({
            providerId: envelope.providerId,
            idempotencyKey,
            externalTransactionId: envelope.externalTransactionId,
            playerId: envelope.playerId,
            walletId: envelope.walletId,
            roundId: envelope.roundId,
            gameId: envelope.gameId,
            kind: envelope.kind,
            money: envelope.money,
            referenceExternalTransactionId:
              envelope.referenceExternalTransactionId,
            source: "sqs",
            inboxContext: {
              consumerName: CONSUMER_NAME,
              messageId: effectiveMessageId,
              payloadHash: rawHash,
              receivedAt,
            },
          });

          const env = loadEnv();
          const faultPoint =
            faultInjectionOverride !== undefined
              ? faultInjectionOverride
              : getActiveFaultInjectionPoint(env);
          if (faultPoint === "AFTER_COMMIT_BEFORE_SQS_ACK") {
            throw new FaultInjectionError("AFTER_COMMIT_BEFORE_SQS_ACK");
          }

          if (receiptHandle) {
            await this.sqs.deleteWagerMessage(receiptHandle);
          }
          this.metrics.sqsMessagesTotal.inc({ outcome: "ack" });
          return "ACK";
        } catch (error) {
          const classified = classifySqsError(error);

          if (classified.action === "ACK") {
            if (receiptHandle) {
              await this.sqs.deleteWagerMessage(receiptHandle);
            }
            this.metrics.sqsMessagesTotal.inc({ outcome: "business_ack" });
            return "ACK";
          }

          if (classified.action === "DLQ") {
            await this.sqs.sendToDlq({
              messageBody: rawBody,
              messageGroupId: `dlq-${sqsMessageId}`,
              messageDeduplicationId: `${sqsMessageId}-${Bun.randomUUIDv7()}`,
              messageAttributes: {
                dlqReason: {
                  DataType: "String",
                  StringValue: classified.reason,
                },
                failureCode: {
                  DataType: "String",
                  StringValue: classified.failureCode,
                },
                originalMessageId: {
                  DataType: "String",
                  StringValue: sqsMessageId,
                },
              },
            });
            if (receiptHandle) {
              await this.sqs.deleteWagerMessage(receiptHandle);
            }
            this.metrics.sqsMessagesTotal.inc({ outcome: "dlq" });
            this.logger.warn("SQS message sent to DLQ", {
              reason: classified.reason,
              failureCode: classified.failureCode,
            });
            return "DLQ";
          }

          // Transitório: devolve imediatamente no shutdown, senão aplica backoff exponencial
          if (receiptHandle) {
            const visibilitySeconds = this.shuttingDown
              ? 0
              : computeSqsVisibilityBackoffSeconds(receiveCount);
            await this.sqs.changeWagerMessageVisibility(
              receiptHandle,
              visibilitySeconds,
            );
          }
          this.metrics.sqsMessagesTotal.inc({ outcome: "retry" });
          this.logger.warn("Transient error handling SQS message; scheduled retry", {
            reason: classified.reason,
            receiveCount,
          });
          return "RETRY";
        }
      },
    );
  }

  private async runLoop(): Promise<void> {
    const env = loadEnv();
    while (this.running) {
      this.receiveAbortController = new AbortController();
      try {
        await this.pollOnce({
          waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
          maxMessages: env.SQS_MAX_MESSAGES,
          abortSignal: this.receiveAbortController.signal,
        });
      } catch (err) {
        if (!this.shuttingDown) {
          this.logger.error("SQS consumer poll loop error", {
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        this.receiveAbortController = null;
      }
    }
  }
}

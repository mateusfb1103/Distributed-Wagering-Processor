import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../../shared/infrastructure/config/env.ts";
import { AppLogger } from "../../shared/infrastructure/observability/logger.service.ts";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service.ts";
import { SqsClientService } from "../infrastructure/sqs-client.service.ts";

interface ClaimedOutboxRow {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly correlation_id: string | null;
  readonly attempt_count: number;
}

export interface OutboxRunResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Publisher assíncrono do padrão Outbox (D09):
 * - Claim curto com `FOR UPDATE SKIP LOCKED` + lease (`locked_by`, `locked_until`)
 * - Publicação em `wagering-events.fifo` fora da transação SQL
 * - Confirmação condicionada ao dono do lease; backoff exponencial com jitter em falhas
 */
@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly instanceId = `outbox-${Bun.randomUUIDv7()}`;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: Promise<void> | null = null;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsClientService) private readonly sqs: SqsClientService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (env.NODE_ENV === "test") {
      return;
    }
    if (env.APP_ROLES.includes("outbox")) {
      this.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(pollIntervalMs?: number): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const interval = pollIntervalMs ?? loadEnv().OUTBOX_POLL_INTERVAL_MS;
    this.scheduleNext(interval);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeRun) {
      await this.activeRun;
    }
  }

  async runOnce(options?: {
    readonly batchSize?: number;
    readonly leaseMs?: number;
    readonly instanceIdOverride?: string;
  }): Promise<OutboxRunResult> {
    const env = loadEnv();
    const batchSize = options?.batchSize ?? env.OUTBOX_BATCH_SIZE;
    const leaseMs = options?.leaseMs ?? env.OUTBOX_LEASE_MS;
    const ownerId = options?.instanceIdOverride ?? this.instanceId;

    const claimed = await this.claimBatch(batchSize, leaseMs, ownerId);
    let published = 0;
    let failed = 0;

    for (const row of claimed) {
      try {
        const body =
          typeof row.payload === "string"
            ? row.payload
            : JSON.stringify(row.payload);

        await this.sqs.sendEventMessage({
          messageBody: body,
          messageGroupId: row.aggregate_id,
          messageDeduplicationId: row.event_id,
          messageAttributes: {
            eventType: {
              DataType: "String",
              StringValue: row.event_type,
            },
            ...(row.correlation_id
              ? {
                  correlationId: {
                    DataType: "String",
                    StringValue: row.correlation_id,
                  },
                }
              : {}),
          },
        });

        await this.markPublished(row.event_id, ownerId);
        this.metrics.outboxPublishedTotal.inc({ event_type: row.event_type });
        published += 1;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        await this.scheduleRetry(
          row.event_id,
          ownerId,
          Number(row.attempt_count),
          message,
        );
        this.metrics.outboxFailuresTotal.inc({ event_type: row.event_type });
        this.logger.warn("Failed to publish outbox event", {
          eventId: row.event_id,
          eventType: row.event_type,
          errorMessage: message,
        });
        failed += 1;
      }
    }

    await this.refreshPendingGauge();

    return {
      claimed: claimed.length,
      published,
      failed,
    };
  }

  private async claimBatch(
    batchSize: number,
    leaseMs: number,
    ownerId: string,
  ): Promise<ClaimedOutboxRow[]> {
    const em = this.orm.em.fork() as EntityManager;
    return em.transactional(async (tx) => {
      return tx.execute<ClaimedOutboxRow[]>(
        `WITH claimed AS (
           SELECT event_id
           FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= now()
             AND (locked_until IS NULL OR locked_until <= now())
           ORDER BY created_at ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_messages o
         SET locked_by = ?,
             locked_until = now() + (? * interval '1 millisecond')
         FROM claimed
         WHERE o.event_id = claimed.event_id
         RETURNING
           o.event_id,
           o.aggregate_type,
           o.aggregate_id,
           o.event_type,
           o.payload,
           o.correlation_id,
           o.attempt_count`,
        [batchSize, ownerId, leaseMs],
      );
    });
  }

  private async markPublished(
    eventId: string,
    ownerId: string,
  ): Promise<void> {
    const em = this.orm.em.fork() as EntityManager;
    await em.execute(
      `UPDATE outbox_messages
       SET published_at = now(),
           locked_by = NULL,
           locked_until = NULL,
           last_error = NULL
       WHERE event_id = ?
         AND locked_by = ?
         AND published_at IS NULL`,
      [eventId, ownerId],
    );
  }

  private async scheduleRetry(
    eventId: string,
    ownerId: string,
    currentAttemptCount: number,
    errorMessage: string,
  ): Promise<void> {
    const nextAttempt = currentAttemptCount + 1;
    const baseDelayMs = Math.min(1000 * 2 ** currentAttemptCount, 60_000);
    const jitterMs = Math.floor(Math.random() * Math.max(100, baseDelayMs * 0.25));
    const delayMs = baseDelayMs + jitterMs;

    const em = this.orm.em.fork() as EntityManager;
    await em.execute(
      `UPDATE outbox_messages
       SET attempt_count = ?,
           next_attempt_at = now() + (? * interval '1 millisecond'),
           locked_by = NULL,
           locked_until = NULL,
           last_error = ?
       WHERE event_id = ?
         AND locked_by = ?
         AND published_at IS NULL`,
      [nextAttempt, delayMs, errorMessage.slice(0, 500), eventId, ownerId],
    );
  }

  private async refreshPendingGauge(): Promise<void> {
    try {
      const em = this.orm.em.fork() as EntityManager;
      const rows = await em.execute<
        { count: string; oldest_age_seconds: string | null }[]
      >(
        `SELECT
           count(*)::text AS count,
           EXTRACT(EPOCH FROM (now() - MIN(created_at)))::text AS oldest_age_seconds
         FROM outbox_messages
         WHERE published_at IS NULL`,
      );
      this.metrics.outboxPendingGauge.set(Number(rows[0]?.count ?? "0"));
      this.metrics.outboxOldestPendingAgeSeconds.set(
        Number(rows[0]?.oldest_age_seconds ?? "0"),
      );
    } catch {
      // Métrica auxiliar: não interrompe publicação
    }
  }

  private scheduleNext(intervalMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      if (!this.running) {
        return;
      }
      this.activeRun = this.runOnce()
        .then(() => undefined)
        .catch((err) => {
          this.logger.error("Outbox publisher tick failed", {
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.activeRun = null;
          this.scheduleNext(intervalMs);
        });
    }, intervalMs);
  }
}

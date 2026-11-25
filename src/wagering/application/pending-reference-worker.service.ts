import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessageSchema } from "../../database/entities/outbox-message.entity.ts";
import { WagerTransactionSchema } from "../../database/entities/wager-transaction.entity.ts";
import { WalletLedgerEntrySchema } from "../../database/entities/wallet-ledger-entry.entity.ts";
import type { WalletRecord } from "../../database/entities/wallet.entity.ts";
import { domainEventToOutboxRecord } from "../../messaging/infrastructure/persistence/outbox.mapper.ts";
import type { IdGenerator } from "../../shared/domain/id-generator.ts";
import { loadEnv } from "../../shared/infrastructure/config/env.ts";
import { isPgLockNotAvailableOrTimeout } from "../../shared/infrastructure/database/pg-errors.ts";
import { AppLogger } from "../../shared/infrastructure/observability/logger.service.ts";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service.ts";
import { requestContext } from "../../shared/infrastructure/observability/request-context.ts";
import { ID_GENERATOR } from "../../shared/infrastructure/shared-infra.module.ts";
import {
  ledgerEntryToRecord,
  walletToDomain,
} from "../../wallet/infrastructure/persistence/wallet.mapper.ts";
import { retryPendingWagerTransaction } from "../domain/wager-processor.service.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";
import { wagerTransactionToDomain } from "../infrastructure/persistence/wager-transaction.mapper.ts";
import { PendingWakeUpRegistry } from "./pending-wakeup.registry.ts";

export interface PendingWorkerRunResult {
  readonly checked: number;
  readonly processed: number;
  readonly rejected: number;
  readonly rescheduled: number;
}

interface DuePendingRow {
  readonly id: string;
  readonly wallet_id: string;
}

interface WalletRawRow {
  readonly id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/**
 * Worker de resolução de transações em `PENDING_REFERENCE` (D11):
 * - Polling em lote com backoff exponencial + TTL
 * - Wake-up imediato quando uma transação `BET`/`WIN` é confirmada
 * - Sempre adquire lock na `wallet` antes de atualizar `wager_transactions` (ordem canônica sem deadlock)
 */
@Injectable()
export class PendingReferenceWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: Promise<void> | null = null;
  private wakeUpQueued = false;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(PendingWakeUpRegistry)
    private readonly wakeUpRegistry: PendingWakeUpRegistry,
  ) {
    this.wakeUpRegistry.register(() => this.triggerWakeUp());
  }

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (env.NODE_ENV === "test") {
      return;
    }
    if (env.APP_ROLES.includes("pending-worker")) {
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
    const interval =
      pollIntervalMs ?? loadEnv().PENDING_WORKER_POLL_INTERVAL_MS;
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

  triggerWakeUp(): void {
    if (!this.running) {
      return;
    }
    if (this.activeRun) {
      this.wakeUpQueued = true;
      return;
    }
    this.activeRun = this.runOnce()
      .then(() => undefined)
      .catch((err) => {
        this.logger.error("Pending reference wake-up run failed", {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.activeRun = null;
        if (this.wakeUpQueued && this.running) {
          this.wakeUpQueued = false;
          this.triggerWakeUp();
        }
      });
  }

  async runOnce(batchSizeOverride?: number): Promise<PendingWorkerRunResult> {
    const env = loadEnv();
    const batchSize = batchSizeOverride ?? env.PENDING_WORKER_BATCH_SIZE;
    const em = this.orm.em.fork() as EntityManager;

    const dueRows = await em.execute<DuePendingRow[]>(
      `SELECT id, wallet_id
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND next_attempt_at <= now()
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      [batchSize],
    );

    let processed = 0;
    let rejected = 0;
    let rescheduled = 0;

    for (const row of dueRows) {
      try {
        const outcome = await this.processSinglePending(
          row.id,
          row.wallet_id,
          env.LOCK_TIMEOUT_MS,
        );
        if (outcome === "PROCESSED") {
          processed += 1;
        } else if (outcome === "REJECTED") {
          rejected += 1;
        } else if (outcome === "RESCHEDULED") {
          rescheduled += 1;
        }
      } catch (error) {
        if (isPgLockNotAvailableOrTimeout(error)) {
          this.logger.warn("Wallet busy during pending reference retry", {
            transactionId: row.id,
            walletId: row.wallet_id,
          });
          continue;
        }
        this.logger.error("Error retrying pending reference transaction", {
          transactionId: row.id,
          walletId: row.wallet_id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      checked: dueRows.length,
      processed,
      rejected,
      rescheduled,
    };
  }

  private async processSinglePending(
    transactionId: string,
    walletId: string,
    lockTimeoutMs: number,
  ): Promise<"PROCESSED" | "REJECTED" | "RESCHEDULED" | "SKIPPED"> {
    const em = this.orm.em.fork() as EntityManager;
    const correlationId = requestContext.get().correlationId ?? null;

    return em.transactional(async (tx) => {
      await tx.execute(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);

      const walletRows = await tx.execute<WalletRawRow[]>(
        `SELECT id, player_id, currency, balance::text AS balance, version, created_at, updated_at
         FROM wallets
         WHERE id = ?
         FOR UPDATE`,
        [walletId],
      );
      const walletRow = walletRows[0];
      if (!walletRow) {
        return "SKIPPED";
      }

      const txRecord = await tx.findOne(WagerTransactionSchema, {
        id: transactionId,
      });
      if (!txRecord || txRecord.status !== "PENDING_REFERENCE") {
        return "SKIPPED";
      }

      const existingTx = wagerTransactionToDomain(txRecord);
      const walletRecord: WalletRecord = {
        id: walletRow.id,
        playerId: walletRow.player_id,
        currency: walletRow.currency,
        balance: walletRow.balance,
        version: Number(walletRow.version),
        createdAt: new Date(walletRow.created_at),
        updatedAt: new Date(walletRow.updated_at),
      };
      const wallet = walletToDomain(walletRecord);
      const previousVersion = wallet.version;

      let referenceTx: WagerTransaction | null = null;
      let isReferenceAlreadyReversed = false;

      if (existingTx.referenceExternalTransactionId) {
        const refRecord = await tx.findOne(WagerTransactionSchema, {
          providerId: existingTx.providerId,
          externalTransactionId: existingTx.referenceExternalTransactionId,
        });
        if (refRecord) {
          referenceTx = wagerTransactionToDomain(refRecord);
          const existingReversal = await tx.execute<{ id: string }[]>(
            `SELECT id FROM wager_transactions WHERE reference_transaction_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED' LIMIT 1`,
            [referenceTx.id],
          );
          isReferenceAlreadyReversed = existingReversal.length > 0;
        }
      }

      const now = new Date();
      const outcome = retryPendingWagerTransaction({
        existingTransaction: existingTx,
        wallet,
        referenceTransaction: referenceTx,
        isReferenceAlreadyReversed,
        now,
        idGenerator: this.idGenerator,
      });

      if (outcome.ledgerEntry !== null) {
        const updated = await tx.execute<{ id: string }[]>(
          `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING id`,
          [
            wallet.balance.toString(),
            wallet.version,
            wallet.updatedAt.toISOString(),
            wallet.id,
            previousVersion,
          ],
        );
        if (updated.length !== 1) {
          throw new Error("Concurrent wallet version mismatch in pending worker.");
        }
      }

      await tx.execute(
        `UPDATE wager_transactions
         SET status = ?,
             reference_transaction_id = ?,
             failure_code = ?,
             result_balance = ?,
             result_wallet_version = ?,
             attempt_count = ?,
             next_attempt_at = ?,
             processed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'PENDING_REFERENCE'`,
        [
          outcome.transaction.status,
          outcome.transaction.referenceTransactionId,
          outcome.transaction.failureCode,
          outcome.transaction.resultBalance?.toString() ?? null,
          outcome.transaction.resultWalletVersion,
          outcome.transaction.attemptCount,
          outcome.transaction.nextAttemptAt?.toISOString() ?? null,
          outcome.transaction.processedAt?.toISOString() ?? null,
          outcome.transaction.updatedAt.toISOString(),
          outcome.transaction.id,
        ],
      );

      if (outcome.ledgerEntry !== null) {
        tx.create(
          WalletLedgerEntrySchema,
          ledgerEntryToRecord(outcome.ledgerEntry),
        );
        await tx.flush();
      }

      for (const event of outcome.events) {
        tx.create(
          OutboxMessageSchema,
          domainEventToOutboxRecord(event, correlationId, now),
        );
      }
      if (outcome.events.length > 0) {
        await tx.flush();
      }

      if (outcome.transaction.status === "PROCESSED") {
        this.metrics.pendingReferenceResolutionsTotal.inc({
          outcome: "processed",
        });
        return "PROCESSED";
      }
      if (outcome.transaction.status === "REJECTED") {
        this.metrics.pendingReferenceResolutionsTotal.inc({
          outcome: "rejected",
        });
        return "REJECTED";
      }
      this.metrics.pendingReferenceResolutionsTotal.inc({
        outcome: "rescheduled",
      });
      return "RESCHEDULED";
    });
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
          this.logger.error("Pending reference worker tick failed", {
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

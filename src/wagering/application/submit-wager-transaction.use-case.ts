import { Inject, Injectable, Optional } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessageSchema } from "../../database/entities/outbox-message.entity.ts";
import { WagerTransactionSchema } from "../../database/entities/wager-transaction.entity.ts";
import { WalletLedgerEntrySchema } from "../../database/entities/wallet-ledger-entry.entity.ts";
import type { WalletRecord } from "../../database/entities/wallet.entity.ts";
import { domainEventToOutboxRecord } from "../../messaging/infrastructure/persistence/outbox.mapper.ts";
import {
  BusinessRuleError,
  ConflictError,
} from "../../shared/domain/domain-error.ts";
import type { IdGenerator } from "../../shared/domain/id-generator.ts";
import { Money } from "../../shared/domain/money.ts";
import { hashWagerPayload } from "../../shared/domain/payload-hasher.ts";
import { ProviderIdentityPort } from "../../shared/infrastructure/auth/provider-identity.port.ts";
import { loadEnv } from "../../shared/infrastructure/config/env.ts";
import {
  extractPgError,
  isPgDeadlockOrSerialization,
  isPgLockNotAvailableOrTimeout,
  isPgUnavailableError,
  isPgUniqueViolation,
} from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import { AppLogger } from "../../shared/infrastructure/observability/logger.service.ts";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service.ts";
import { requestContext } from "../../shared/infrastructure/observability/request-context.ts";
import { ID_GENERATOR } from "../../shared/infrastructure/shared-infra.module.ts";
import { ledgerEntryToRecord, walletToDomain } from "../../wallet/infrastructure/persistence/wallet.mapper.ts";
import { processNewWagerTransaction } from "../domain/wager-processor.service.ts";
import { WagerTransaction } from "../domain/wager-transaction.ts";
import {
  wagerTransactionToDomain,
  wagerTransactionToRecord,
} from "../infrastructure/persistence/wager-transaction.mapper.ts";
import { PendingWakeUpRegistry } from "./pending-wakeup.registry.ts";

export interface SubmitWagerTransactionCommand {
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly referenceExternalTransactionId?: string | null;
  readonly source?: "http" | "sqs";
  readonly inboxContext?: {
    readonly consumerName: string;
    readonly messageId: string;
    readonly payloadHash: string;
    readonly receivedAt: Date;
  };
}

export interface SubmitWagerTransactionResult {
  readonly transaction: WagerTransaction;
  readonly idempotentReplay: boolean;
  readonly wokeUpPendingCount: number;
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

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(ProviderIdentityPort)
    private readonly providerIdentity: ProviderIdentityPort,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional()
    @Inject(PendingWakeUpRegistry)
    private readonly wakeUpRegistry?: PendingWakeUpRegistry,
  ) {}

  async execute(
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const startNs = Bun.nanoseconds();
    const env = loadEnv();
    const identity = this.providerIdentity.resolveFromBody(command.providerId);
    const source = command.source ?? "http";

    const money = Money.fromString(
      command.money.amount,
      command.money.currency,
    );

    const validatedKind = WagerTransaction.validateExternalContract({
      providerId: identity.providerId,
      idempotencyKey: command.idempotencyKey,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    const payloadHash = hashWagerPayload({
      providerId: identity.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: validatedKind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    requestContext.set({
      providerId: identity.providerId,
      walletId: command.walletId,
    });

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.executeTransactional({
          command,
          providerId: identity.providerId,
          money,
          payloadHash,
          lockTimeoutMs: env.LOCK_TIMEOUT_MS,
          pendingReferenceTtlMs: env.PENDING_REFERENCE_TTL_MS,
        });

        requestContext.set({ transactionId: result.transaction.id });

        const durationSeconds = (Bun.nanoseconds() - startNs) / 1_000_000_000;
        this.metrics.recordTransaction({
          kind: result.transaction.kind,
          status: result.transaction.status,
          source,
          failureCode: result.transaction.failureCode,
          durationSeconds,
        });
        if (result.idempotentReplay) {
          this.metrics.duplicatesDetectedTotal.inc({
            source,
            kind: "idempotency",
          });
        }

        this.logger.info("Wager transaction handled", {
          kind: result.transaction.kind,
          status: result.transaction.status,
          failureCode: result.transaction.failureCode,
          idempotentReplay: result.idempotentReplay,
          source,
        });

        if (result.wokeUpPendingCount > 0) {
          this.wakeUpRegistry?.trigger();
        }

        return result;
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          if (attempt < maxAttempts) {
            continue;
          }
          const pg = extractPgError(error);
          if (pg?.constraint === "uq_wager_tx_provider_external") {
            throw new ConflictError(
              "EXTERNAL_TRANSACTION_ID_CONFLICT",
              "externalTransactionId already used by this provider.",
            );
          }
          if (pg?.constraint === "uq_wager_tx_provider_idempotency") {
            throw new ConflictError(
              "IDEMPOTENCY_KEY_CONFLICT",
              "Idempotency-Key conflict detected.",
            );
          }
          if (pg?.constraint === "uq_wager_tx_single_reversal") {
            throw new BusinessRuleError(
              "REFERENCE_ALREADY_REVERSED",
              "Reference transaction has already been reversed.",
            );
          }
        }

        if (isPgLockNotAvailableOrTimeout(error)) {
          throw new TransientServiceException(
            "WALLET_BUSY",
            "Wallet is currently locked by another transaction; retry shortly.",
            1,
          );
        }

        if (isPgDeadlockOrSerialization(error) || isPgUnavailableError(error)) {
          throw new TransientServiceException(
            "DATABASE_UNAVAILABLE",
            "Database is temporarily unavailable.",
            2,
          );
        }

        throw error;
      }
    }

    throw new TransientServiceException(
      "SERVICE_UNAVAILABLE",
      "Unable to complete transaction after conflict retry.",
    );
  }

  private async executeTransactional(params: {
    readonly command: SubmitWagerTransactionCommand;
    readonly providerId: string;
    readonly money: Money;
    readonly payloadHash: string;
    readonly lockTimeoutMs: number;
    readonly pendingReferenceTtlMs: number;
  }): Promise<SubmitWagerTransactionResult> {
    const { command, providerId, money, payloadHash } = params;
    const em = this.orm.em.fork() as EntityManager;
    const ctx = requestContext.get();
    const correlationId = ctx.correlationId ?? null;

    return em.transactional(async (tx) => {
      await tx.execute(`SET LOCAL lock_timeout = '${params.lockTimeoutMs}ms'`);

      // D01: sonda NOWAIT para contabilizar contenção antes de aguardar FOR UPDATE
      const lockedRows = await this.lockWalletRow(tx, command.walletId);
      const lockedRow = lockedRows[0];
      if (!lockedRow) {
        throw new BusinessRuleError(
          "WALLET_NOT_FOUND",
          `Wallet ${command.walletId} was not found.`,
          { walletId: command.walletId },
        );
      }

      const walletRecord: WalletRecord = {
        id: lockedRow.id,
        playerId: lockedRow.player_id,
        currency: lockedRow.currency,
        balance: lockedRow.balance,
        version: Number(lockedRow.version),
        createdAt: new Date(lockedRow.created_at),
        updatedAt: new Date(lockedRow.updated_at),
      };
      const wallet = walletToDomain(walletRecord);

      // D02: checagem de idempotência sob lock da wallet
      const existingByIdem = await tx.findOne(WagerTransactionSchema, {
        providerId,
        idempotencyKey: command.idempotencyKey,
      });

      if (existingByIdem) {
        const domainTx = wagerTransactionToDomain(existingByIdem);
        if (!domainTx.matchesPayloadHash(payloadHash)) {
          throw new ConflictError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency-Key already exists with a different payload.",
          );
        }
        if (command.inboxContext) {
          await this.upsertInboxProcessed(tx, command.inboxContext, new Date());
        }
        return {
          transaction: domainTx,
          idempotentReplay: true,
          wokeUpPendingCount: 0,
        };
      }

      const existingByExternal = await tx.findOne(WagerTransactionSchema, {
        providerId,
        externalTransactionId: command.externalTransactionId,
      });
      if (existingByExternal) {
        throw new ConflictError(
          "EXTERNAL_TRANSACTION_ID_CONFLICT",
          "externalTransactionId already registered for this provider.",
        );
      }

      const refExternalId =
        command.referenceExternalTransactionId?.trim() ?? null;
      let referenceTx: WagerTransaction | null = null;
      let isReferenceAlreadyReversed = false;

      if (
        (command.kind === "REFUND" || command.kind === "ROLLBACK") &&
        refExternalId
      ) {
        const refRecord = await tx.findOne(WagerTransactionSchema, {
          providerId,
          externalTransactionId: refExternalId,
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
      const previousVersion = wallet.version;

      const outcome = processNewWagerTransaction({
        command: {
          providerId,
          idempotencyKey: command.idempotencyKey,
          externalTransactionId: command.externalTransactionId,
          playerId: command.playerId,
          walletId: command.walletId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: refExternalId,
          payloadHash,
        },
        wallet,
        referenceTransaction: referenceTx,
        isReferenceAlreadyReversed,
        pendingReferenceTtlMs: params.pendingReferenceTtlMs,
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
          throw new TransientServiceException(
            "WALLET_BUSY",
            "Concurrent wallet version mismatch.",
          );
        }
      }

      tx.create(
        WagerTransactionSchema,
        wagerTransactionToRecord(outcome.transaction),
      );
      await tx.flush();

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

      let wokeUpPendingCount = 0;
      if (
        outcome.transaction.status === "PROCESSED" &&
        (outcome.transaction.kind === "BET" ||
          outcome.transaction.kind === "WIN")
      ) {
        const wokeRows = await tx.execute<{ id: string }[]>(
          `UPDATE wager_transactions
           SET next_attempt_at = now(), updated_at = now()
           WHERE provider_id = ?
             AND reference_external_transaction_id = ?
             AND status = 'PENDING_REFERENCE'
           RETURNING id`,
          [providerId, command.externalTransactionId],
        );
        wokeUpPendingCount = wokeRows.length;
      }

      if (command.inboxContext) {
        await this.upsertInboxProcessed(tx, command.inboxContext, now);
      }

      return {
        transaction: outcome.transaction,
        idempotentReplay: false,
        wokeUpPendingCount,
      };
    });
  }

  private async lockWalletRow(
    tx: EntityManager,
    walletId: string,
  ): Promise<WalletRawRow[]> {
    await tx.execute("SAVEPOINT sp_wallet_nowait");
    try {
      const rows = await tx.execute<WalletRawRow[]>(
        `SELECT id, player_id, currency, balance::text AS balance, version, created_at, updated_at
         FROM wallets
         WHERE id = ?
         FOR UPDATE NOWAIT`,
        [walletId],
      );
      await tx.execute("RELEASE SAVEPOINT sp_wallet_nowait");
      return rows;
    } catch (error) {
      if (isPgLockNotAvailableOrTimeout(error)) {
        await tx.execute("ROLLBACK TO SAVEPOINT sp_wallet_nowait");
        await tx.execute("RELEASE SAVEPOINT sp_wallet_nowait");
        this.metrics.incrementLockContention();
        return tx.execute<WalletRawRow[]>(
          `SELECT id, player_id, currency, balance::text AS balance, version, created_at, updated_at
           FROM wallets
           WHERE id = ?
           FOR UPDATE`,
          [walletId],
        );
      }
      throw error;
    }
  }

  private async upsertInboxProcessed(
    tx: EntityManager,
    inbox: NonNullable<SubmitWagerTransactionCommand["inboxContext"]>,
    now: Date,
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, status, received_at, processed_at)
       VALUES (?, ?, ?, 'PROCESSED', ?, ?)
       ON CONFLICT (consumer_name, message_id)
       DO UPDATE SET status = 'PROCESSED', processed_at = EXCLUDED.processed_at`,
      [
        inbox.consumerName,
        inbox.messageId,
        inbox.payloadHash,
        inbox.receivedAt.toISOString(),
        now.toISOString(),
      ],
    );
  }
}

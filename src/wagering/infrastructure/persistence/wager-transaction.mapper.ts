import type { WagerTransactionRecord } from "../../../database/entities/wager-transaction.entity.ts";
import type { FailureCode } from "../../../shared/domain/failure-codes.ts";
import { Money } from "../../../shared/domain/money.ts";
import { WagerTransaction } from "../../domain/wager-transaction.ts";
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction.types.ts";

export function wagerTransactionToDomain(
  record: WagerTransactionRecord,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    idempotencyKey: record.idempotencyKey,
    externalTransactionId: record.externalTransactionId,
    playerId: record.playerId,
    walletId: record.walletId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.rehydrate(record.amount, record.currency),
    payloadHash: record.payloadHash,
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId,
    failureCode: record.failureCode as FailureCode | null,
    resultBalance:
      record.resultBalance !== null
        ? Money.rehydrate(record.resultBalance, record.currency)
        : null,
    resultWalletVersion: record.resultWalletVersion,
    attemptCount: record.attemptCount,
    nextAttemptAt:
      record.nextAttemptAt !== null ? new Date(record.nextAttemptAt) : null,
    expiresAt: record.expiresAt !== null ? new Date(record.expiresAt) : null,
    processedAt:
      record.processedAt !== null ? new Date(record.processedAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  });
}

export function wagerTransactionToRecord(
  tx: WagerTransaction,
): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    idempotencyKey: tx.idempotencyKey,
    externalTransactionId: tx.externalTransactionId,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    payloadHash: tx.payloadHash,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    status: tx.status,
    failureCode: tx.failureCode,
    resultBalance: tx.resultBalance?.toString() ?? null,
    resultWalletVersion: tx.resultWalletVersion,
    attemptCount: tx.attemptCount,
    nextAttemptAt: tx.nextAttemptAt,
    expiresAt: tx.expiresAt,
    processedAt: tx.processedAt,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  };
}

import type { DomainEvent } from "../../shared/domain/domain-event.ts";
import type { FailureCode } from "../../shared/domain/failure-codes.ts";
import type { WagerTransaction } from "./wager-transaction.ts";
import type { WagerTransactionKind } from "./wager-transaction.types.ts";

export interface WagerTransactionProcessedPayload {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceTransactionId: string | null;
  readonly referenceExternalTransactionId: string | null;
  readonly balanceAfter: string;
  readonly walletVersion: number;
  readonly processedAt: string;
}

export interface WagerTransactionRejectedPayload {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly failureCode: FailureCode;
  readonly balanceAfter: string | null;
  readonly walletVersion: number | null;
  readonly rejectedAt: string;
}

export interface WagerTransactionPendingReferencePayload {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId: string;
  readonly expiresAt: string;
}

export type WagerTransactionProcessedEvent = DomainEvent<
  "WagerTransactionProcessed",
  WagerTransactionProcessedPayload
>;

export type WagerTransactionRejectedEvent = DomainEvent<
  "WagerTransactionRejected",
  WagerTransactionRejectedPayload
>;

export type WagerTransactionPendingReferenceEvent = DomainEvent<
  "WagerTransactionPendingReference",
  WagerTransactionPendingReferencePayload
>;

export type WagerDomainEvent =
  | WagerTransactionProcessedEvent
  | WagerTransactionRejectedEvent
  | WagerTransactionPendingReferenceEvent;

export function buildWagerProcessedEvent(
  eventId: string,
  tx: WagerTransaction,
  occurredAt: Date,
): WagerTransactionProcessedEvent {
  return {
    eventId,
    eventType: "WagerTransactionProcessed",
    aggregateType: "WagerTransaction",
    aggregateId: tx.walletId,
    occurredAt,
    payload: {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      referenceTransactionId: tx.referenceTransactionId,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      balanceAfter: tx.resultBalance!.toString(),
      walletVersion: tx.resultWalletVersion!,
      processedAt: (tx.processedAt ?? occurredAt).toISOString(),
    },
  };
}

export function buildWagerRejectedEvent(
  eventId: string,
  tx: WagerTransaction,
  occurredAt: Date,
): WagerTransactionRejectedEvent {
  return {
    eventId,
    eventType: "WagerTransactionRejected",
    aggregateType: "WagerTransaction",
    aggregateId: tx.walletId,
    occurredAt,
    payload: {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      failureCode: tx.failureCode!,
      balanceAfter: tx.resultBalance?.toString() ?? null,
      walletVersion: tx.resultWalletVersion,
      rejectedAt: occurredAt.toISOString(),
    },
  };
}

export function buildWagerPendingReferenceEvent(
  eventId: string,
  tx: WagerTransaction,
  occurredAt: Date,
): WagerTransactionPendingReferenceEvent {
  return {
    eventId,
    eventType: "WagerTransactionPendingReference",
    aggregateType: "WagerTransaction",
    aggregateId: tx.walletId,
    occurredAt,
    payload: {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId!,
      expiresAt: tx.expiresAt!.toISOString(),
    },
  };
}

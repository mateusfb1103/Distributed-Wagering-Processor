import type { FailureCode } from "../../shared/domain/failure-codes.ts";
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from "../../shared/domain/integration-event.ts";
import type { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry.ts";
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

export interface WalletBalanceChangedPayload {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly balanceBefore: { readonly amount: string; readonly currency: string };
  readonly balanceAfter: { readonly amount: string; readonly currency: string };
  readonly walletVersion: number;
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<WagerTransactionProcessedPayload> {
  readonly eventType = "WagerTransactionProcessed" as const;
  readonly version = 1;

  static create(
    props: Omit<
      IntegrationEventProps<WagerTransactionProcessedPayload>,
      "aggregateType"
    >,
  ): WagerTransactionProcessedEvent {
    return new WagerTransactionProcessedEvent({
      ...props,
      aggregateType: "WagerTransaction",
    });
  }
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<WagerTransactionRejectedPayload> {
  readonly eventType = "WagerTransactionRejected" as const;
  readonly version = 1;

  static create(
    props: Omit<
      IntegrationEventProps<WagerTransactionRejectedPayload>,
      "aggregateType"
    >,
  ): WagerTransactionRejectedEvent {
    return new WagerTransactionRejectedEvent({
      ...props,
      aggregateType: "WagerTransaction",
    });
  }
}

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<WagerTransactionPendingReferencePayload> {
  readonly eventType = "WagerTransactionPendingReference" as const;
  readonly version = 1;

  static create(
    props: Omit<
      IntegrationEventProps<WagerTransactionPendingReferencePayload>,
      "aggregateType"
    >,
  ): WagerTransactionPendingReferenceEvent {
    return new WagerTransactionPendingReferenceEvent({
      ...props,
      aggregateType: "WagerTransaction",
    });
  }
}

export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedPayload> {
  readonly eventType = "WalletBalanceChanged" as const;
  readonly version = 1;

  static create(
    props: Omit<
      IntegrationEventProps<WalletBalanceChangedPayload>,
      "aggregateType"
    >,
  ): WalletBalanceChangedEvent {
    return new WalletBalanceChangedEvent({
      ...props,
      aggregateType: "Wallet",
    });
  }
}

export type WagerDomainEvent =
  | WagerTransactionProcessedEvent
  | WagerTransactionRejectedEvent
  | WagerTransactionPendingReferenceEvent
  | WalletBalanceChangedEvent;

export function buildWagerProcessedEvent(
  eventId: string,
  tx: WagerTransaction,
  occurredAt: Date,
  correlationId = "",
): WagerTransactionProcessedEvent {
  return WagerTransactionProcessedEvent.create({
    eventId,
    aggregateId: tx.walletId,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
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
  });
}

export function buildWagerRejectedEvent(
  eventId: string,
  tx: WagerTransaction,
  occurredAt: Date,
  correlationId = "",
): WagerTransactionRejectedEvent {
  return WagerTransactionRejectedEvent.create({
    eventId,
    aggregateId: tx.walletId,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
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
  });
}

export function buildWagerPendingReferenceEvent(
  eventId: string,
  tx: WagerTransaction,
  occurredAt: Date,
  correlationId = "",
): WagerTransactionPendingReferenceEvent {
  return WagerTransactionPendingReferenceEvent.create({
    eventId,
    aggregateId: tx.walletId,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
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
  });
}

export function buildWalletBalanceChangedEvent(
  eventId: string,
  entry: WalletLedgerEntry,
  occurredAt: Date,
  correlationId = "",
): WalletBalanceChangedEvent {
  return WalletBalanceChangedEvent.create({
    eventId,
    aggregateId: entry.walletId,
    correlationId,
    causationId: entry.transactionId,
    occurredAt,
    data: {
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.amount.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
    },
  });
}

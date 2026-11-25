import { BusinessRuleError } from "../../shared/domain/domain-error.ts";
import type { BusinessFailureCode } from "../../shared/domain/failure-codes.ts";
import type { IdGenerator } from "../../shared/domain/id-generator.ts";
import type { Money } from "../../shared/domain/money.ts";
import type { Wallet } from "../../wallet/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry.ts";
import {
  buildWagerPendingReferenceEvent,
  buildWagerProcessedEvent,
  buildWagerRejectedEvent,
  type WagerDomainEvent,
} from "./wager-events.ts";
import {
  type ExternalWagerContractInput,
  WagerTransaction,
} from "./wager-transaction.ts";
import type { ExternalWagerKind } from "./wager-transaction.types.ts";

const INITIAL_PENDING_BACKOFF_MS = 1_000;
const MAX_PENDING_BACKOFF_MS = 60_000;

export function computePendingBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(INITIAL_PENDING_BACKOFF_MS * 2 ** exponent, MAX_PENDING_BACKOFF_MS);
}

export interface ProcessNewWagerParams {
  readonly command: ExternalWagerContractInput & { readonly payloadHash: string };
  readonly wallet: Wallet;
  readonly referenceTransaction: WagerTransaction | null;
  readonly isReferenceAlreadyReversed: boolean;
  readonly pendingReferenceTtlMs: number;
  readonly now: Date;
  readonly idGenerator: IdGenerator;
}

export interface RetryPendingWagerParams {
  readonly existingTransaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly referenceTransaction: WagerTransaction | null;
  readonly isReferenceAlreadyReversed: boolean;
  readonly now: Date;
  readonly idGenerator: IdGenerator;
}

export interface WagerProcessingOutcome {
  readonly transaction: WagerTransaction;
  readonly ledgerEntry: WalletLedgerEntry | null;
  readonly events: readonly WagerDomainEvent[];
}

function validateWalletOwnershipAndCurrency(
  wallet: Wallet,
  playerId: string,
  money: Money,
): BusinessFailureCode | null {
  if (wallet.playerId !== playerId) {
    return "WALLET_PLAYER_MISMATCH";
  }
  if (wallet.currency !== money.currency) {
    return "CURRENCY_MISMATCH";
  }
  return null;
}

function validateReversalReference(params: {
  readonly kind: "REFUND" | "ROLLBACK";
  readonly providerId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly money: Money;
  readonly reference: WagerTransaction;
  readonly isReferenceAlreadyReversed: boolean;
}): BusinessFailureCode | null {
  const { reference } = params;

  if (
    reference.providerId !== params.providerId ||
    reference.walletId !== params.walletId ||
    reference.playerId !== params.playerId ||
    reference.roundId !== params.roundId ||
    reference.gameId !== params.gameId ||
    !reference.money.sameCurrency(params.money)
  ) {
    return "REFERENCE_MISMATCH";
  }

  if (params.kind === "REFUND" && reference.kind !== "BET") {
    return "REFERENCE_KIND_NOT_ALLOWED";
  }

  if (
    params.kind === "ROLLBACK" &&
    reference.kind !== "BET" &&
    reference.kind !== "WIN"
  ) {
    return "REFERENCE_KIND_NOT_ALLOWED";
  }

  if (reference.status !== "PROCESSED") {
    return "REFERENCE_NOT_PROCESSED";
  }

  if (params.isReferenceAlreadyReversed) {
    return "REFERENCE_ALREADY_REVERSED";
  }

  if (!params.money.equals(reference.money)) {
    return "AMOUNT_MISMATCH";
  }

  return null;
}

function applyReversalToWallet(params: {
  readonly wallet: Wallet;
  readonly transactionId: string;
  readonly reference: WagerTransaction;
  readonly money: Money;
  readonly now: Date;
  readonly idGenerator: IdGenerator;
}):
  | { readonly ok: true; readonly ledgerEntry: WalletLedgerEntry }
  | { readonly ok: false; readonly failureCode: BusinessFailureCode } {
  if (params.reference.kind === "BET") {
    const ledgerEntry = params.wallet.credit(
      params.money,
      params.transactionId,
      params.idGenerator.nextId(),
      params.now,
    );
    return { ok: true, ledgerEntry };
  }

  try {
    const ledgerEntry = params.wallet.debit(
      params.money,
      params.transactionId,
      params.idGenerator.nextId(),
      params.now,
      "REVERSAL_INSUFFICIENT_FUNDS",
    );
    return { ok: true, ledgerEntry };
  } catch (err) {
    if (err instanceof BusinessRuleError && err.code === "REVERSAL_INSUFFICIENT_FUNDS") {
      return { ok: false, failureCode: "REVERSAL_INSUFFICIENT_FUNDS" };
    }
    throw err;
  }
}

/**
 * Executa a máquina de regras de domínio para uma transação nova (HTTP ou SQS).
 */
export function processNewWagerTransaction(
  params: ProcessNewWagerParams,
): WagerProcessingOutcome {
  const { command, wallet, now, idGenerator } = params;
  const kind: ExternalWagerKind = WagerTransaction.validateExternalContract(command);
  const transactionId = idGenerator.nextId();
  const refExternalId = command.referenceExternalTransactionId?.trim() ?? null;

  const rejectNew = (
    failureCode: BusinessFailureCode,
    referenceTransactionId: string | null = null,
  ): WagerProcessingOutcome => {
    const tx = WagerTransaction.createRejected({
      id: transactionId,
      providerId: command.providerId,
      idempotencyKey: command.idempotencyKey,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money: command.money,
      payloadHash: command.payloadHash,
      referenceExternalTransactionId: refExternalId,
      referenceTransactionId,
      failureCode,
      resultBalance: wallet.balance,
      resultWalletVersion: wallet.version,
      now,
    });
    return {
      transaction: tx,
      ledgerEntry: null,
      events: [buildWagerRejectedEvent(idGenerator.nextId(), tx, now)],
    };
  };

  const processNew = (
    ledgerEntry: WalletLedgerEntry | null,
    referenceTransactionId: string | null = null,
  ): WagerProcessingOutcome => {
    const tx = WagerTransaction.createProcessed({
      id: transactionId,
      providerId: command.providerId,
      idempotencyKey: command.idempotencyKey,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money: command.money,
      payloadHash: command.payloadHash,
      referenceExternalTransactionId: refExternalId,
      referenceTransactionId,
      resultBalance: wallet.balance,
      resultWalletVersion: wallet.version,
      now,
    });
    return {
      transaction: tx,
      ledgerEntry,
      events: [buildWagerProcessedEvent(idGenerator.nextId(), tx, now)],
    };
  };

  const ownershipOrCurrencyFailure = validateWalletOwnershipAndCurrency(
    wallet,
    command.playerId,
    command.money,
  );
  if (ownershipOrCurrencyFailure !== null) {
    return rejectNew(ownershipOrCurrencyFailure);
  }

  if (kind === "BET") {
    try {
      const ledgerEntry = wallet.debit(
        command.money,
        transactionId,
        idGenerator.nextId(),
        now,
        "INSUFFICIENT_FUNDS",
      );
      return processNew(ledgerEntry);
    } catch (err) {
      if (err instanceof BusinessRuleError && err.code === "INSUFFICIENT_FUNDS") {
        return rejectNew("INSUFFICIENT_FUNDS");
      }
      throw err;
    }
  }

  if (kind === "WIN") {
    const ledgerEntry = wallet.credit(
      command.money,
      transactionId,
      idGenerator.nextId(),
      now,
    );
    return processNew(ledgerEntry);
  }

  if (kind === "LOSS") {
    return processNew(null);
  }

  // REFUND ou ROLLBACK
  const reversalKind = kind;
  if (params.referenceTransaction === null) {
    const tx = WagerTransaction.createPendingReference({
      id: transactionId,
      providerId: command.providerId,
      idempotencyKey: command.idempotencyKey,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: reversalKind,
      money: command.money,
      payloadHash: command.payloadHash,
      referenceExternalTransactionId: refExternalId!,
      nextAttemptAt: new Date(now.getTime() + INITIAL_PENDING_BACKOFF_MS),
      expiresAt: new Date(now.getTime() + params.pendingReferenceTtlMs),
      now,
    });
    return {
      transaction: tx,
      ledgerEntry: null,
      events: [buildWagerPendingReferenceEvent(idGenerator.nextId(), tx, now)],
    };
  }

  const refFailure = validateReversalReference({
    kind: reversalKind,
    providerId: command.providerId,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    money: command.money,
    reference: params.referenceTransaction,
    isReferenceAlreadyReversed: params.isReferenceAlreadyReversed,
  });
  if (refFailure !== null) {
    return rejectNew(refFailure, params.referenceTransaction.id);
  }

  const applied = applyReversalToWallet({
    wallet,
    transactionId,
    reference: params.referenceTransaction,
    money: command.money,
    now,
    idGenerator,
  });
  if (!applied.ok) {
    return rejectNew(applied.failureCode, params.referenceTransaction.id);
  }

  return processNew(applied.ledgerEntry, params.referenceTransaction.id);
}

/**
 * Reavalia uma transação em `PENDING_REFERENCE` (worker ou wake-up — D11).
 * Retries intermediários sem referência não republicam `WagerTransactionPendingReference`.
 */
export function retryPendingWagerTransaction(
  params: RetryPendingWagerParams,
): WagerProcessingOutcome {
  const { existingTransaction: tx, wallet, now, idGenerator } = params;

  if (tx.status !== "PENDING_REFERENCE") {
    throw new BusinessRuleError(
      "REFERENCE_NOT_PROCESSED",
      `Expected transaction ${tx.id} to be PENDING_REFERENCE, got ${tx.status}.`,
    );
  }

  if (tx.kind !== "REFUND" && tx.kind !== "ROLLBACK") {
    throw new BusinessRuleError(
      "REFERENCE_KIND_NOT_ALLOWED",
      `Pending transaction ${tx.id} has unexpected kind ${tx.kind}.`,
    );
  }

  const ownershipOrCurrencyFailure = validateWalletOwnershipAndCurrency(
    wallet,
    tx.playerId,
    tx.money,
  );
  if (ownershipOrCurrencyFailure !== null) {
    tx.markRejected({
      failureCode: ownershipOrCurrencyFailure,
      resultBalance: wallet.balance,
      resultWalletVersion: wallet.version,
      now,
    });
    return {
      transaction: tx,
      ledgerEntry: null,
      events: [buildWagerRejectedEvent(idGenerator.nextId(), tx, now)],
    };
  }

  if (params.referenceTransaction === null) {
    if (tx.isExpired(now)) {
      tx.markRejected({
        failureCode: "REFERENCE_NOT_FOUND",
        resultBalance: wallet.balance,
        resultWalletVersion: wallet.version,
        now,
      });
      return {
        transaction: tx,
        ledgerEntry: null,
        events: [buildWagerRejectedEvent(idGenerator.nextId(), tx, now)],
      };
    }

    const backoffMs = computePendingBackoffMs(tx.attemptCount + 1);
    tx.scheduleNextAttempt(now, backoffMs);
    return {
      transaction: tx,
      ledgerEntry: null,
      events: [],
    };
  }

  const refFailure = validateReversalReference({
    kind: tx.kind,
    providerId: tx.providerId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    money: tx.money,
    reference: params.referenceTransaction,
    isReferenceAlreadyReversed: params.isReferenceAlreadyReversed,
  });
  if (refFailure !== null) {
    tx.markRejected({
      failureCode: refFailure,
      referenceTransactionId: params.referenceTransaction.id,
      resultBalance: wallet.balance,
      resultWalletVersion: wallet.version,
      now,
    });
    return {
      transaction: tx,
      ledgerEntry: null,
      events: [buildWagerRejectedEvent(idGenerator.nextId(), tx, now)],
    };
  }

  const applied = applyReversalToWallet({
    wallet,
    transactionId: tx.id,
    reference: params.referenceTransaction,
    money: tx.money,
    now,
    idGenerator,
  });
  if (!applied.ok) {
    tx.markRejected({
      failureCode: applied.failureCode,
      referenceTransactionId: params.referenceTransaction.id,
      resultBalance: wallet.balance,
      resultWalletVersion: wallet.version,
      now,
    });
    return {
      transaction: tx,
      ledgerEntry: null,
      events: [buildWagerRejectedEvent(idGenerator.nextId(), tx, now)],
    };
  }

  tx.markProcessed({
    referenceTransactionId: params.referenceTransaction.id,
    resultBalance: wallet.balance,
    resultWalletVersion: wallet.version,
    now,
  });

  return {
    transaction: tx,
    ledgerEntry: applied.ledgerEntry,
    events: [buildWagerProcessedEvent(idGenerator.nextId(), tx, now)],
  };
}

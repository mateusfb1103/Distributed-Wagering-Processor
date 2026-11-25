import {
  ContractViolationError,
  InvalidStateTransitionError,
} from "../../shared/domain/domain-error.ts";
import type { FailureCode } from "../../shared/domain/failure-codes.ts";
import type { Money } from "../../shared/domain/money.ts";
import {
  type ExternalWagerKind,
  isReversalKind,
  isTerminalStatus,
  WAGER_TRANSACTION_KINDS,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "./wager-transaction.types.ts";

export interface ExternalWagerContractInput {
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | null;
}

export interface CreateOpeningTransactionParams {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly payloadHash: string;
  readonly now: Date;
}

export interface CreateProcessedTransactionParams {
  readonly id: string;
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ExternalWagerKind;
  readonly money: Money;
  readonly payloadHash: string;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly resultBalance: Money;
  readonly resultWalletVersion: number;
  readonly now: Date;
}

export interface CreateRejectedTransactionParams {
  readonly id: string;
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ExternalWagerKind;
  readonly money: Money;
  readonly payloadHash: string;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly failureCode: FailureCode;
  readonly resultBalance: Money | null;
  readonly resultWalletVersion: number | null;
  readonly now: Date;
}

export interface CreatePendingReferenceTransactionParams {
  readonly id: string;
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: "REFUND" | "ROLLBACK";
  readonly money: Money;
  readonly payloadHash: string;
  readonly referenceExternalTransactionId: string;
  readonly nextAttemptAt: Date;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface RehydrateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly payloadHash: string;
  readonly referenceExternalTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | null;
  readonly failureCode: FailureCode | null;
  readonly resultBalance: Money | null;
  readonly resultWalletVersion: number | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly expiresAt: Date | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Entidade `WagerTransaction` — representa uma transação recebida de provedor (ou `OPENING`),
 * incluindo snapshot de resultado para replay idempotente (D02) e estado de pendência (D11).
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly payloadHash: string;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;

  private statusValue: WagerTransactionStatus;
  private referenceTransactionIdValue: string | null;
  private failureCodeValue: FailureCode | null;
  private resultBalanceValue: Money | null;
  private resultWalletVersionValue: number | null;
  private attemptCountValue: number;
  private nextAttemptAtValue: Date | null;
  private expiresAtValue: Date | null;
  private processedAtValue: Date | null;
  private updatedAtValue: Date;

  private constructor(props: RehydrateWagerTransactionProps) {
    this.id = props.id;
    this.providerId = props.providerId;
    this.idempotencyKey = props.idempotencyKey;
    this.externalTransactionId = props.externalTransactionId;
    this.playerId = props.playerId;
    this.walletId = props.walletId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.money = props.money;
    this.payloadHash = props.payloadHash;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    this.createdAt = props.createdAt;

    this.statusValue = props.status;
    this.referenceTransactionIdValue = props.referenceTransactionId;
    this.failureCodeValue = props.failureCode;
    this.resultBalanceValue = props.resultBalance;
    this.resultWalletVersionValue = props.resultWalletVersion;
    this.attemptCountValue = props.attemptCount;
    this.nextAttemptAtValue = props.nextAttemptAt;
    this.expiresAtValue = props.expiresAt;
    this.processedAtValue = props.processedAt;
    this.updatedAtValue = props.updatedAt;
  }

  get status(): WagerTransactionStatus {
    return this.statusValue;
  }

  get referenceTransactionId(): string | null {
    return this.referenceTransactionIdValue;
  }

  get failureCode(): FailureCode | null {
    return this.failureCodeValue;
  }

  get resultBalance(): Money | null {
    return this.resultBalanceValue;
  }

  get resultWalletVersion(): number | null {
    return this.resultWalletVersionValue;
  }

  get attemptCount(): number {
    return this.attemptCountValue;
  }

  get nextAttemptAt(): Date | null {
    return this.nextAttemptAtValue;
  }

  get expiresAt(): Date | null {
    return this.expiresAtValue;
  }

  get processedAt(): Date | null {
    return this.processedAtValue;
  }

  get updatedAt(): Date {
    return this.updatedAtValue;
  }

  /**
   * Valida contrato de entrada de transações externas (D04, D06, D14).
   */
  static validateExternalContract(
    input: ExternalWagerContractInput,
  ): ExternalWagerKind {
    if (
      !WAGER_TRANSACTION_KINDS.includes(input.kind as WagerTransactionKind) ||
      input.kind === "OPENING"
    ) {
      throw new ContractViolationError(
        "UNSUPPORTED_KIND",
        `Unsupported wager transaction kind "${input.kind}".`,
        { kind: input.kind },
      );
    }

    if (input.idempotencyKey.trim().length === 0) {
      throw new ContractViolationError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key must not be empty.",
      );
    }

    if (
      input.providerId.trim().length === 0 ||
      input.providerId === "system" ||
      input.externalTransactionId.trim().length === 0 ||
      input.playerId.trim().length === 0 ||
      input.walletId.trim().length === 0 ||
      input.roundId.trim().length === 0 ||
      input.gameId.trim().length === 0
    ) {
      throw new ContractViolationError(
        "INVALID_PAYLOAD",
        "Required identifier fields must be valid non-empty strings (providerId cannot be 'system').",
      );
    }

    const kind = input.kind as ExternalWagerKind;

    if (kind === "LOSS") {
      if (!input.money.isZero()) {
        throw new ContractViolationError(
          "INVALID_MONEY",
          "LOSS transactions must have amount 0.00.",
        );
      }
    } else if (!input.money.isPositive()) {
      throw new ContractViolationError(
        "INVALID_MONEY",
        `${kind} transactions must have amount > 0.00.`,
      );
    }

    const ref = input.referenceExternalTransactionId?.trim() ?? "";

    if (isReversalKind(kind)) {
      if (ref.length === 0) {
        throw new ContractViolationError(
          "REFERENCE_REQUIRED",
          `${kind} requires referenceExternalTransactionId.`,
        );
      }
    } else if (
      input.referenceExternalTransactionId !== undefined &&
      input.referenceExternalTransactionId !== null
    ) {
      throw new ContractViolationError(
        "REFERENCE_NOT_ALLOWED",
        `${kind} must not provide referenceExternalTransactionId.`,
      );
    }

    return kind;
  }

  static createOpening(
    params: CreateOpeningTransactionParams,
  ): WagerTransaction {
    return new WagerTransaction({
      id: params.id,
      providerId: "system",
      idempotencyKey: `opening:${params.walletId}`,
      externalTransactionId: `opening:${params.walletId}`,
      playerId: params.playerId,
      walletId: params.walletId,
      roundId: `opening:${params.walletId}`,
      gameId: "system",
      kind: "OPENING",
      money: params.money,
      payloadHash: params.payloadHash,
      referenceExternalTransactionId: null,
      status: "PROCESSED",
      referenceTransactionId: null,
      failureCode: null,
      resultBalance: params.money,
      resultWalletVersion: 1,
      attemptCount: 1,
      nextAttemptAt: null,
      expiresAt: null,
      processedAt: params.now,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static createProcessed(
    params: CreateProcessedTransactionParams,
  ): WagerTransaction {
    return new WagerTransaction({
      id: params.id,
      providerId: params.providerId,
      idempotencyKey: params.idempotencyKey,
      externalTransactionId: params.externalTransactionId,
      playerId: params.playerId,
      walletId: params.walletId,
      roundId: params.roundId,
      gameId: params.gameId,
      kind: params.kind,
      money: params.money,
      payloadHash: params.payloadHash,
      referenceExternalTransactionId: params.referenceExternalTransactionId,
      status: "PROCESSED",
      referenceTransactionId: params.referenceTransactionId,
      failureCode: null,
      resultBalance: params.resultBalance,
      resultWalletVersion: params.resultWalletVersion,
      attemptCount: 1,
      nextAttemptAt: null,
      expiresAt: null,
      processedAt: params.now,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static createRejected(
    params: CreateRejectedTransactionParams,
  ): WagerTransaction {
    return new WagerTransaction({
      id: params.id,
      providerId: params.providerId,
      idempotencyKey: params.idempotencyKey,
      externalTransactionId: params.externalTransactionId,
      playerId: params.playerId,
      walletId: params.walletId,
      roundId: params.roundId,
      gameId: params.gameId,
      kind: params.kind,
      money: params.money,
      payloadHash: params.payloadHash,
      referenceExternalTransactionId: params.referenceExternalTransactionId,
      status: "REJECTED",
      referenceTransactionId: params.referenceTransactionId,
      failureCode: params.failureCode,
      resultBalance: params.resultBalance,
      resultWalletVersion: params.resultWalletVersion,
      attemptCount: 1,
      nextAttemptAt: null,
      expiresAt: null,
      processedAt: null,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static createPendingReference(
    params: CreatePendingReferenceTransactionParams,
  ): WagerTransaction {
    return new WagerTransaction({
      id: params.id,
      providerId: params.providerId,
      idempotencyKey: params.idempotencyKey,
      externalTransactionId: params.externalTransactionId,
      playerId: params.playerId,
      walletId: params.walletId,
      roundId: params.roundId,
      gameId: params.gameId,
      kind: params.kind,
      money: params.money,
      payloadHash: params.payloadHash,
      referenceExternalTransactionId: params.referenceExternalTransactionId,
      status: "PENDING_REFERENCE",
      referenceTransactionId: null,
      failureCode: null,
      resultBalance: null,
      resultWalletVersion: null,
      attemptCount: 1,
      nextAttemptAt: params.nextAttemptAt,
      expiresAt: params.expiresAt,
      processedAt: null,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  /**
   * Reconstrói `WagerTransaction` persistida sem revalidação (D05).
   */
  static rehydrate(props: RehydrateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props);
  }

  markProcessed(params: {
    readonly referenceTransactionId: string | null;
    readonly resultBalance: Money;
    readonly resultWalletVersion: number;
    readonly now: Date;
  }): void {
    this.assertNotTerminal("PROCESSED");
    this.statusValue = "PROCESSED";
    this.referenceTransactionIdValue = params.referenceTransactionId;
    this.failureCodeValue = null;
    this.resultBalanceValue = params.resultBalance;
    this.resultWalletVersionValue = params.resultWalletVersion;
    this.nextAttemptAtValue = null;
    this.processedAtValue = params.now;
    this.updatedAtValue = params.now;
  }

  markRejected(params: {
    readonly failureCode: FailureCode;
    readonly referenceTransactionId?: string | null;
    readonly resultBalance: Money | null;
    readonly resultWalletVersion: number | null;
    readonly now: Date;
  }): void {
    this.assertNotTerminal("REJECTED");
    this.statusValue = "REJECTED";
    if (params.referenceTransactionId !== undefined) {
      this.referenceTransactionIdValue = params.referenceTransactionId;
    }
    this.failureCodeValue = params.failureCode;
    this.resultBalanceValue = params.resultBalance;
    this.resultWalletVersionValue = params.resultWalletVersion;
    this.nextAttemptAtValue = null;
    this.processedAtValue = null;
    this.updatedAtValue = params.now;
  }

  markFailed(params: {
    readonly failureCode: FailureCode;
    readonly now: Date;
  }): void {
    this.assertNotTerminal("FAILED");
    this.statusValue = "FAILED";
    this.failureCodeValue = params.failureCode;
    this.nextAttemptAtValue = null;
    this.processedAtValue = null;
    this.updatedAtValue = params.now;
  }

  scheduleNextAttempt(now: Date, backoffMs: number): void {
    this.assertNotTerminal("PENDING_REFERENCE");
    this.attemptCountValue += 1;
    this.nextAttemptAtValue = new Date(now.getTime() + backoffMs);
    this.updatedAtValue = now;
  }

  isExpired(now: Date): boolean {
    if (this.expiresAtValue === null) {
      return false;
    }
    return now.getTime() >= this.expiresAtValue.getTime();
  }

  matchesPayloadHash(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  private assertNotTerminal(targetStatus: WagerTransactionStatus): void {
    if (isTerminalStatus(this.statusValue)) {
      throw new InvalidStateTransitionError(
        `Cannot transition WagerTransaction ${this.id} from terminal status ${this.statusValue} to ${targetStatus}.`,
        {
          transactionId: this.id,
          fromStatus: this.statusValue,
          toStatus: targetStatus,
        },
      );
    }
  }
}

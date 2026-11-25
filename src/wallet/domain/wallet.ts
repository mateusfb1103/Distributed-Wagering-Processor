import {
  BusinessRuleError,
  ContractViolationError,
} from "../../shared/domain/domain-error.ts";
import { Money } from "../../shared/domain/money.ts";
import { WalletLedgerEntry } from "./wallet-ledger-entry.ts";

export interface CreateWalletParams {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly now: Date;
  readonly openingTransactionId?: string;
  readonly openingLedgerEntryId?: string;
}

export interface CreateWalletResult {
  readonly wallet: Wallet;
  readonly openingLedgerEntry: WalletLedgerEntry | null;
}

export interface RehydrateWalletParams {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Aggregate Root `Wallet` — unidade de concorrência e consistência financeira.
 */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;

  private balanceValue: Money;
  private versionValue: number;
  private updatedAtValue: Date;

  private constructor(params: RehydrateWalletParams) {
    this.id = params.id;
    this.playerId = params.playerId;
    this.currency = params.currency;
    this.balanceValue = params.balance;
    this.versionValue = params.version;
    this.createdAt = params.createdAt;
    this.updatedAtValue = params.updatedAt;
  }

  get balance(): Money {
    return this.balanceValue;
  }

  get version(): number {
    return this.versionValue;
  }

  get updatedAt(): Date {
    return this.updatedAtValue;
  }

  static create(params: CreateWalletParams): CreateWalletResult {
    if (params.playerId.trim().length === 0) {
      throw new ContractViolationError(
        "INVALID_PAYLOAD",
        "playerId must not be empty.",
      );
    }

    const currency = params.initialBalance.currency;
    const wallet = new Wallet({
      id: params.id,
      playerId: params.playerId,
      currency,
      balance: params.initialBalance,
      version: 1,
      createdAt: params.now,
      updatedAt: params.now,
    });

    if (!params.initialBalance.isPositive()) {
      return { wallet, openingLedgerEntry: null };
    }

    if (!params.openingTransactionId || !params.openingLedgerEntryId) {
      throw new ContractViolationError(
        "INVALID_PAYLOAD",
        "openingTransactionId and openingLedgerEntryId are required when initialBalance > 0.",
      );
    }

    const openingLedgerEntry = WalletLedgerEntry.create({
      id: params.openingLedgerEntryId,
      walletId: wallet.id,
      transactionId: params.openingTransactionId,
      direction: "CREDIT",
      amount: params.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: params.initialBalance,
      walletVersion: 1,
      createdAt: params.now,
    });

    return { wallet, openingLedgerEntry };
  }

  /**
   * Reconstrói `Wallet` persistida no banco sem revalidação (D05).
   */
  static rehydrate(params: RehydrateWalletParams): Wallet {
    return new Wallet(params);
  }

  credit(
    amount: Money,
    transactionId: string,
    ledgerEntryId: string,
    now: Date,
  ): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new ContractViolationError(
        "INVALID_MONEY",
        "Credit amount must be strictly positive.",
      );
    }

    const balanceBefore = this.balanceValue;
    const balanceAfter = balanceBefore.add(amount);
    const nextVersion = this.versionValue + 1;

    this.balanceValue = balanceAfter;
    this.versionValue = nextVersion;
    this.updatedAtValue = now;

    return WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: "CREDIT",
      amount,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: now,
    });
  }

  debit(
    amount: Money,
    transactionId: string,
    ledgerEntryId: string,
    now: Date,
    insufficientFundsCode:
      | "INSUFFICIENT_FUNDS"
      | "REVERSAL_INSUFFICIENT_FUNDS" = "INSUFFICIENT_FUNDS",
  ): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new ContractViolationError(
        "INVALID_MONEY",
        "Debit amount must be strictly positive.",
      );
    }

    if (!this.balanceValue.canSubtract(amount)) {
      throw new BusinessRuleError(
        insufficientFundsCode,
        "Insufficient wallet balance for debit.",
        {
          walletId: this.id,
          currency: this.currency,
        },
      );
    }

    const balanceBefore = this.balanceValue;
    const balanceAfter = balanceBefore.subtract(amount);
    const nextVersion = this.versionValue + 1;

    this.balanceValue = balanceAfter;
    this.versionValue = nextVersion;
    this.updatedAtValue = now;

    return WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: "DEBIT",
      amount,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: now,
    });
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new BusinessRuleError(
        "CURRENCY_MISMATCH",
        `Wallet currency is ${this.currency}, got ${amount.currency}.`,
        { expectedCurrency: this.currency, actualCurrency: amount.currency },
      );
    }
  }
}

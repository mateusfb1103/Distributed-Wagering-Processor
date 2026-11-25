import {
  BusinessRuleError,
  ContractViolationError,
} from "../../shared/domain/domain-error.ts";
import type { Money } from "../../shared/domain/money.ts";

export type LedgerDirection = "CREDIT" | "DEBIT";

export interface WalletLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;
}

/**
 * Lançamento imutável no razão da carteira (`wallet_ledger_entries`).
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.amount = props.amount;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.walletVersion = props.walletVersion;
    this.createdAt = props.createdAt;
  }

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    if (!props.amount.isPositive()) {
      throw new ContractViolationError(
        "INVALID_MONEY",
        "Ledger entry amount must be strictly positive.",
      );
    }

    if (
      !props.amount.sameCurrency(props.balanceBefore) ||
      !props.amount.sameCurrency(props.balanceAfter)
    ) {
      throw new BusinessRuleError(
        "CURRENCY_MISMATCH",
        "Ledger entry amount and balances must share the same currency.",
      );
    }

    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new ContractViolationError(
        "INVALID_PAYLOAD",
        "Ledger entry walletVersion must be an integer >= 1.",
      );
    }

    const expectedAfter =
      props.direction === "CREDIT"
        ? props.balanceBefore.add(props.amount)
        : props.balanceBefore.subtract(props.amount);

    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new ContractViolationError(
        "INVALID_PAYLOAD",
        "Ledger entry balance arithmetic invariant failed.",
      );
    }

    return new WalletLedgerEntry(props);
  }

  /**
   * Reconstrói lançamento persistido no banco sem revalidação (D05).
   */
  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }
}

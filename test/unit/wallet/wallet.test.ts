import { describe, expect, test } from "bun:test";
import {
  BusinessRuleError,
  ContractViolationError,
} from "../../../src/shared/domain/domain-error.ts";
import { Money } from "../../../src/shared/domain/money.ts";
import { Wallet } from "../../../src/wallet/domain/wallet.ts";
import { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry.ts";

describe("Wallet & WalletLedgerEntry", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");

  test("creates wallet with zero initial balance without opening ledger entry", () => {
    const { wallet, openingLedgerEntry } = Wallet.create({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.zero("BRL"),
      now,
    });

    expect(wallet.balance.toString()).toBe("0.00");
    expect(wallet.version).toBe(1);
    expect(openingLedgerEntry).toBeNull();
  });

  test("creates wallet with positive initial balance and valid opening ledger entry", () => {
    const { wallet, openingLedgerEntry } = Wallet.create({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.fromString("100.00", "BRL"),
      now,
      openingTransactionId: "tx-open-1",
      openingLedgerEntryId: "le-open-1",
    });

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(openingLedgerEntry).not.toBeNull();
    expect(openingLedgerEntry?.direction).toBe("CREDIT");
    expect(openingLedgerEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingLedgerEntry?.balanceAfter.toString()).toBe("100.00");
    expect(openingLedgerEntry?.walletVersion).toBe(1);
  });

  test("credit and debit update balance/version monotonically and emit ledger entries", () => {
    const { wallet } = Wallet.create({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.fromString("100.00", "BRL"),
      now,
      openingTransactionId: "tx-open-1",
      openingLedgerEntryId: "le-open-1",
    });

    const debitEntry = wallet.debit(
      Money.fromString("35.50", "BRL"),
      "tx-2",
      "le-2",
      new Date("2026-11-25T12:01:00.000Z"),
    );
    expect(wallet.balance.toString()).toBe("64.50");
    expect(wallet.version).toBe(2);
    expect(debitEntry.direction).toBe("DEBIT");
    expect(debitEntry.balanceBefore.toString()).toBe("100.00");
    expect(debitEntry.balanceAfter.toString()).toBe("64.50");
    expect(debitEntry.walletVersion).toBe(2);

    const creditEntry = wallet.credit(
      Money.fromString("15.50", "BRL"),
      "tx-3",
      "le-3",
      new Date("2026-11-25T12:02:00.000Z"),
    );
    expect(wallet.balance.toString()).toBe("80.00");
    expect(wallet.version).toBe(3);
    expect(creditEntry.direction).toBe("CREDIT");
    expect(creditEntry.balanceBefore.toString()).toBe("64.50");
    expect(creditEntry.balanceAfter.toString()).toBe("80.00");
    expect(creditEntry.walletVersion).toBe(3);
  });

  test("debit rejects insufficient funds without mutating wallet", () => {
    const { wallet } = Wallet.create({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.fromString("20.00", "BRL"),
      now,
      openingTransactionId: "tx-open-1",
      openingLedgerEntryId: "le-open-1",
    });

    expect(() =>
      wallet.debit(Money.fromString("20.01", "BRL"), "tx-2", "le-2", now),
    ).toThrow(BusinessRuleError);

    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects empty playerId, zero credit/debit, currency mismatch, and invalid ledger arithmetic", () => {
    expect(() =>
      Wallet.create({
        id: "w-1",
        playerId: "   ",
        initialBalance: Money.zero("BRL"),
        now,
      }),
    ).toThrow(ContractViolationError);

    const { wallet } = Wallet.create({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.zero("BRL"),
      now,
    });

    expect(() =>
      wallet.credit(Money.zero("BRL"), "tx-1", "le-1", now),
    ).toThrow(ContractViolationError);

    expect(() =>
      wallet.credit(Money.fromString("10.00", "USD"), "tx-1", "le-1", now),
    ).toThrow(BusinessRuleError);

    expect(() =>
      WalletLedgerEntry.create({
        id: "le-bad",
        walletId: "w-1",
        transactionId: "tx-1",
        direction: "CREDIT",
        amount: Money.fromString("10.00", "BRL"),
        balanceBefore: Money.fromString("0.00", "BRL"),
        balanceAfter: Money.fromString("15.00", "BRL"),
        walletVersion: 2,
        createdAt: now,
      }),
    ).toThrow(ContractViolationError);
  });
});

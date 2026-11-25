import { describe, expect, test } from "bun:test";
import {
  BusinessRuleError,
  ContractViolationError,
} from "../../../src/shared/domain/domain-error.ts";
import { Money } from "../../../src/shared/domain/money.ts";

describe("Money (D04 + R1)", () => {
  test("parses valid amounts and preserves exact precision without floating point", () => {
    const a = Money.fromString("0.10", "BRL");
    const b = Money.fromString("0.20", "BRL");
    const sum = a.add(b);

    expect(sum.toString()).toBe("0.30");
    expect(sum.minorUnits).toBe(30n);

    const large = Money.fromString("999999999999999999.99", "BRL");
    expect(large.toString()).toBe("999999999999999999.99");
    expect(large.minorUnits).toBe(99999999999999999999n);
  });

  test("rejects malformed amounts, negative values, scientific notation and extra decimals", () => {
    const invalidInputs = [
      "",
      "10",
      "10.5",
      "10.123",
      "-1.00",
      "01.00",
      ".50",
      "10,00",
      "1e2",
      "100.00 ",
      " 100.00",
      "NaN",
    ];

    for (const raw of invalidInputs) {
      expect(() => Money.fromString(raw, "BRL")).toThrow(ContractViolationError);
    }
  });

  test("rejects invalid ISO currency codes", () => {
    expect(() => Money.fromString("10.00", "brl")).toThrow(
      ContractViolationError,
    );
    expect(() => Money.fromString("10.00", "BR")).toThrow(
      ContractViolationError,
    );
    expect(() => Money.fromString("10.00", "BRL1")).toThrow(
      ContractViolationError,
    );
  });

  test("supports subtraction, zero checks, comparisons and rehydrate", () => {
    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.toString()).toBe("0.00");

    const fifty = Money.fromString("50.00", "BRL");
    const twenty = Money.fromString("20.00", "BRL");
    expect(fifty.isGreaterThan(twenty)).toBe(true);
    expect(twenty.isLessThan(fifty)).toBe(true);
    expect(fifty.isGreaterThanOrEqual(fifty)).toBe(true);
    expect(fifty.subtract(twenty).toString()).toBe("30.00");

    const rehydrated = Money.rehydrate("123.45", "BRL");
    expect(rehydrated.toString()).toBe("123.45");
    expect(rehydrated.toJSON()).toEqual({ amount: "123.45", currency: "BRL" });
  });

  test("throws INSUFFICIENT_FUNDS when subtracting more than available", () => {
    const ten = Money.fromString("10.00", "BRL");
    const twenty = Money.fromString("20.00", "BRL");

    expect(ten.canSubtract(twenty)).toBe(false);
    try {
      ten.subtract(twenty);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      expect((err as BusinessRuleError).code).toBe("INSUFFICIENT_FUNDS");
    }
  });

  test("throws CURRENCY_MISMATCH on cross-currency operations", () => {
    const brl = Money.fromString("10.00", "BRL");
    const usd = Money.fromString("10.00", "USD");

    expect(brl.equals(usd)).toBe(false);
    expect(() => brl.add(usd)).toThrow(BusinessRuleError);
    expect(() => brl.subtract(usd)).toThrow(BusinessRuleError);
    expect(() => brl.isGreaterThan(usd)).toThrow(BusinessRuleError);
  });
});

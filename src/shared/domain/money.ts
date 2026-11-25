import { BusinessRuleError, ContractViolationError } from "./domain-error.ts";

const STRICT_MONEY_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE_FACTOR = 100n;

function assertValidCurrency(currency: string): void {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new ContractViolationError(
      "INVALID_MONEY",
      `Currency must be a 3-letter uppercase ISO code, received "${currency}".`,
      { currency },
    );
  }
}

function parseAmountToMinorUnits(amount: string): bigint {
  if (!STRICT_MONEY_PATTERN.test(amount)) {
    throw new ContractViolationError(
      "INVALID_MONEY",
      `Amount must match ^(0|[1-9]\\d{0,17})\\.\\d{2}$, received "${amount}".`,
      { amount },
    );
  }

  const dotIdx = amount.indexOf(".");
  const intPart = amount.slice(0, dotIdx);
  const fracPart = amount.slice(dotIdx + 1);
  return BigInt(intPart) * SCALE_FACTOR + BigInt(fracPart);
}

/**
 * Value Object monetário imutável (D04 + R1).
 * Armazena internamente em unidades menores (`bigint`, escala fixa 2) sem uso de ponto flutuante.
 */
export class Money {
  private readonly minorUnitsValue: bigint;
  readonly currency: string;

  private constructor(minorUnits: bigint, currency: string) {
    this.minorUnitsValue = minorUnits;
    this.currency = currency;
  }

  static fromString(amount: string, currency: string): Money {
    assertValidCurrency(currency);
    const minorUnits = parseAmountToMinorUnits(amount);
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    assertValidCurrency(currency);
    return new Money(0n, currency);
  }

  /**
   * Reconstrói `Money` a partir de string `NUMERIC(20,2)` persistida no banco (D05),
   * sem revalidação de regras de negócio.
   */
  static rehydrate(amount: string, currency: string): Money {
    const trimmed = amount.trim();
    const dotIdx = trimmed.indexOf(".");
    if (dotIdx === -1) {
      return new Money(BigInt(trimmed) * SCALE_FACTOR, currency);
    }
    const intPart = trimmed.slice(0, dotIdx);
    const fracPart = trimmed.slice(dotIdx + 1).padEnd(2, "0").slice(0, 2);
    return new Money(BigInt(intPart) * SCALE_FACTOR + BigInt(fracPart), currency);
  }

  get minorUnits(): bigint {
    return this.minorUnitsValue;
  }

  isZero(): boolean {
    return this.minorUnitsValue === 0n;
  }

  isPositive(): boolean {
    return this.minorUnitsValue > 0n;
  }

  sameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.minorUnitsValue === other.minorUnitsValue
    );
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnitsValue > other.minorUnitsValue;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnitsValue >= other.minorUnitsValue;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnitsValue < other.minorUnitsValue;
  }

  canSubtract(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnitsValue >= other.minorUnitsValue;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnitsValue + other.minorUnitsValue, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (this.minorUnitsValue < other.minorUnitsValue) {
      throw new BusinessRuleError(
        "INSUFFICIENT_FUNDS",
        "Insufficient funds for money subtraction.",
        { currency: this.currency },
      );
    }
    return new Money(this.minorUnitsValue - other.minorUnitsValue, this.currency);
  }

  toString(): string {
    const intPart = this.minorUnitsValue / SCALE_FACTOR;
    const fracPart = (this.minorUnitsValue % SCALE_FACTOR)
      .toString()
      .padStart(2, "0");
    return `${intPart.toString()}.${fracPart}`;
  }

  toJSON(): { amount: string; currency: string } {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  private assertSameCurrency(other: Money): void {
    if (!this.sameCurrency(other)) {
      throw new BusinessRuleError(
        "CURRENCY_MISMATCH",
        `Currency mismatch: expected ${this.currency}, got ${other.currency}.`,
        { expectedCurrency: this.currency, actualCurrency: other.currency },
      );
    }
  }
}

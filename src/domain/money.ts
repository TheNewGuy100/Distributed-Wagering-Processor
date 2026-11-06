import { CurrencyMismatchError, InvalidMoneyError } from './errors';

const CURRENCY = /^[A-Z]{3}$/;
// Strict decimal string with exactly two places; no sign, no exponent, no leading zeros.
const DECIMAL = /^(0|[1-9]\d*)\.(\d{2})$/;
// Matches the database column NUMERIC(18,2): at most 16 integer digits.
const MAX_MINOR = 10n ** 18n - 1n;

/**
 * Immutable monetary amount. Stored as integer minor units (bigint) so floating
 * point is never involved. Always non-negative; a result that would go negative throws.
 *
 * There is deliberately no `negate()` or `isNegative()`: a negative Money cannot exist, so "the balance went negative"
 * is not a state this type can represent. Direction lives in the ledger (`CREDIT` / `DEBIT`), amounts stay positive.
 */
export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static fromMinor(minor: bigint, currency: string): Money {
    if (typeof minor !== 'bigint') throw new InvalidMoneyError('minor units must be a bigint');
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`invalid currency: ${String(currency)}`);
    }
    if (minor < 0n) throw new InvalidMoneyError('amount cannot be negative');
    if (minor > MAX_MINOR) throw new InvalidMoneyError('amount out of range');
    return new Money(minor, currency);
  }

  /** Parses a decimal string such as "10.50". Numbers (floats) are rejected on purpose. */
  static parse(value: unknown, currency: string): Money {
    if (typeof value !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    const m = DECIMAL.exec(value);
    if (!m) throw new InvalidMoneyError(`invalid amount format: ${value}`);
    return Money.fromMinor(BigInt(m[1]!) * 100n + BigInt(m[2]!), currency);
  }

  /** Builds a Money from its wire form `{ amount: "10.00", currency: "BRL" }` (the challenge's `MoneyProps`). */
  static from(props: { amount: unknown; currency: string }): Money {
    return Money.parse(props.amount, props.currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinor(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinor(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinor(this.minor - other.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Canonical decimal string with two places, e.g. "10.00". */
  toString(): string {
    const whole = this.minor / 100n;
    const cents = (this.minor % 100n).toString().padStart(2, '0');
    return `${whole}.${cents}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}

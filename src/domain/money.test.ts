import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

describe('Money', () => {
  test('parses and serializes with two decimal places', () => {
    expect(Money.parse('10.50', 'BRL').toString()).toBe('10.50');
    expect(Money.parse('0.01', 'BRL').minor).toBe(1n);
    expect(Money.parse('0.00', 'BRL').isZero()).toBe(true);
    expect(Money.fromMinor(5n, 'BRL').toString()).toBe('0.05');
    expect(Money.fromMinor(123456n, 'BRL').toString()).toBe('1234.56');
  });

  test.each(['10', '10.5', '10.505', '-1.00', '+1.00', '1e2', '1E2', '01.00', ' 1.00', '', '1,00', 'abc', '.50', 'NaN', 'Infinity', '-Infinity', '1.00 ', '0x10'])(
    'rejects malformed string %p',
    (v) => {
      expect(() => Money.parse(v, 'BRL')).toThrow(InvalidMoneyError);
    },
  );

  test('rejects non-string inputs, including floats', () => {
    for (const v of [10.5, 10, null, undefined, {}, 10n]) {
      expect(() => Money.parse(v, 'BRL')).toThrow(InvalidMoneyError);
    }
  });

  test('rejects invalid currency and out-of-range amounts', () => {
    expect(() => Money.parse('1.00', 'brl')).toThrow(InvalidMoneyError);
    expect(() => Money.parse('1.00', 'BR')).toThrow(InvalidMoneyError);
    expect(() => Money.parse('10000000000000000.00', 'BRL')).toThrow(InvalidMoneyError);
    expect(Money.parse('9999999999999999.99', 'BRL').toString()).toBe('9999999999999999.99');
  });

  test('has no floating point drift', () => {
    const sum = Money.parse('0.10', 'BRL').add(Money.parse('0.20', 'BRL'));
    expect(sum.toString()).toBe('0.30');
  });

  test('add and subtract are exact; result cannot be negative', () => {
    const a = Money.parse('10.00', 'BRL');
    const b = Money.parse('3.25', 'BRL');
    expect(a.subtract(b).toString()).toBe('6.75');
    expect(() => b.subtract(a)).toThrow(InvalidMoneyError);
  });

  test('refuses to mix currencies', () => {
    const brl = Money.parse('1.00', 'BRL');
    const usd = Money.parse('1.00', 'USD');
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test('builds from its wire form and compares', () => {
    const m = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(() => Money.from({ amount: 10, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(m.isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.parse('1.00', 'BRL').isLessThan(m)).toBe(true);
  });

  test('has no negative state to represent', () => {
    expect('negate' in Money.prototype).toBe(false);
    expect('isNegative' in Money.prototype).toBe(false);
    expect(() => Money.fromMinor(-1n, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('is immutable', () => {
    const m = Money.parse('1.00', 'BRL');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as { minor: bigint }).minor = 5n;
    }).toThrow();
  });

  test('JSON form carries amount as string', () => {
    expect(JSON.stringify(Money.parse('2.00', 'BRL'))).toBe('{"amount":"2.00","currency":"BRL"}');
  });
});

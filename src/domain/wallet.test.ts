import { describe, expect, test } from 'bun:test';
import { balanceFromLedger, Wallet } from './wallet';
import { Money } from './money';
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError, InvariantViolationError } from './errors';

const brl = (v: string) => Money.parse(v, 'BRL');
const open = () => Wallet.open('w1', 'p1', 'BRL');

describe('Wallet', () => {
  test('opens empty at version 1', () => {
    const w = open();
    expect(w.balance.toString()).toBe('0.00');
    expect(w.version).toBe(1);
    expect(w.pendingEntries).toHaveLength(0);
  });

  test('credit and debit produce one ledger entry each and bump version', () => {
    const w = open();
    w.credit('t1', brl('100.00'));
    w.debit('t2', brl('30.50'));
    expect(w.balance.toString()).toBe('69.50');
    expect(w.version).toBe(3); // 1 at creation + one per balance change
    expect(
      w.pendingEntries.map((e) => [e.direction, e.amount.toString(), e.balanceBefore.toString(), e.balanceAfter.toString()]),
    ).toEqual([
      ['CREDIT', '100.00', '0.00', '100.00'],
      ['DEBIT', '30.50', '100.00', '69.50'],
    ]);
  });

  test('never goes negative; failed debit changes nothing', () => {
    const w = open();
    w.credit('t1', brl('10.00'));
    expect(() => w.debit('t2', brl('10.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.toString()).toBe('10.00');
    expect(w.version).toBe(2);
    expect(w.pendingEntries).toHaveLength(1);
    w.debit('t3', brl('10.00')); // exact balance is allowed
    expect(w.balance.isZero()).toBe(true);
  });

  test('rejects wrong currency and zero amounts without side effects', () => {
    const w = open();
    expect(() => w.credit('t1', Money.parse('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => w.credit('t2', brl('0.00'))).toThrow(InvalidMoneyError);
    expect(w.version).toBe(1);
    expect(w.pendingEntries).toHaveLength(0);
  });

  test('at most one ledger entry per transaction', () => {
    const w = open();
    w.credit('t1', brl('5.00'));
    expect(() => w.credit('t1', brl('5.00'))).toThrow(InvariantViolationError);
    expect(w.balance.toString()).toBe('5.00');
  });

  test('the opening credit is part of creation: a funded wallet is also at version 1', () => {
    const w = open();
    const entry = w.openingCredit('open', brl('1000.00'));
    expect(w.balance.toString()).toBe('1000.00');
    expect(w.version).toBe(1);
    expect(entry).toMatchObject({ direction: 'CREDIT', balanceBefore: brl('0.00'), balanceAfter: brl('1000.00') });
    w.debit('bet', brl('25.00'));
    expect(w.version).toBe(2); // the first change after creation
  });

  test('the opening credit only applies to a new, empty wallet', () => {
    const used = open();
    used.credit('t1', brl('1.00'));
    expect(() => used.openingCredit('open', brl('5.00'))).toThrow(InvariantViolationError);
    const rehydrated = Wallet.rehydrate({ id: 'w1', playerId: 'p1', balance: brl('0.00'), version: 3 });
    expect(() => rehydrated.openingCredit('open', brl('5.00'))).toThrow(InvariantViolationError);
  });

  test('rehydrate keeps balance and version', () => {
    const w = Wallet.rehydrate({ id: 'w1', playerId: 'p1', balance: brl('7.00'), version: 4 });
    w.debit('t1', brl('2.00'));
    expect(w.version).toBe(5);
    expect(w.balance.toString()).toBe('5.00');
  });

  test('balance rebuilt from ledger equals aggregate balance', () => {
    const w = open();
    w.credit('a', brl('50.00'));
    w.debit('b', brl('12.34'));
    w.credit('c', brl('0.01'));
    expect(balanceFromLedger('BRL', w.pendingEntries).equals(w.balance)).toBe(true);
  });
});

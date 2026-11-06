import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';
import { applyDecision, decide, type ReferenceSnapshot, type TransactionInput } from './wager-rules';
import { balanceFromLedger } from './wallet';

const brl = (v: string) => Money.parse(v, 'BRL');

function walletWith(balance: string): Wallet {
  const w = Wallet.open('w1', 'p1', 'BRL');
  if (balance !== '0.00') w.credit('opening', brl(balance));
  return w;
}

const input = (over: Partial<TransactionInput> = {}): TransactionInput => ({
  kind: 'BET',
  providerId: 'pv',
  playerId: 'p1',
  currency: 'BRL',
  amount: brl('10.00'),
  roundId: 'r1',
  referenceExternalId: null,
  ...over,
});

const ref = (over: Partial<ReferenceSnapshot> = {}): ReferenceSnapshot => ({
  id: 'tx-ref',
  providerId: 'pv',
  playerId: 'p1',
  walletId: 'w1',
  currency: 'BRL',
  roundId: 'r1',
  kind: 'BET',
  status: 'PROCESSED',
  amount: brl('10.00'),
  reversedBy: [],
  ...over,
});

describe('BET', () => {
  test('debits when funds suffice, including exact balance', () => {
    expect(decide(input(), walletWith('10.00'), null)).toEqual({ type: 'APPLY', direction: 'DEBIT', amount: brl('10.00') });
  });
  test('rejects with INSUFFICIENT_FUNDS', () => {
    expect(decide(input(), walletWith('9.99'), null)).toEqual({ type: 'REJECT', code: 'INSUFFICIENT_FUNDS' });
  });
  test('rejects zero amount', () => {
    expect(decide(input({ amount: brl('0.00') }), walletWith('5.00'), null)).toMatchObject({ code: 'INVALID_AMOUNT' });
  });
});

describe('WIN / LOSS', () => {
  test('WIN credits', () => {
    expect(decide(input({ kind: 'WIN' }), walletWith('0.00'), null)).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      amount: brl('10.00'),
    });
  });
  test('LOSS has no balance effect and creates no ledger entry', () => {
    const w = walletWith('20.00');
    const d = decide(input({ kind: 'LOSS' }), w, null);
    expect(d).toEqual({ type: 'NO_BALANCE_EFFECT' });
    const before = w.version;
    expect(applyDecision(w, 'tx', d)).toBeNull();
    expect(w.version).toBe(before);
  });
});

describe('common guards', () => {
  test('currency conflict is rejected', () => {
    expect(decide(input({ currency: 'USD', amount: Money.parse('1.00', 'USD') }), walletWith('50.00'), null)).toMatchObject({
      code: 'CURRENCY_MISMATCH',
    });
  });
  test('player must own the wallet', () => {
    expect(decide(input({ playerId: 'other' }), walletWith('50.00'), null)).toMatchObject({ code: 'WALLET_PLAYER_MISMATCH' });
  });
});

describe('REFUND / ROLLBACK', () => {
  const reversal = (kind: 'REFUND' | 'ROLLBACK' = 'REFUND') => input({ kind, referenceExternalId: 'ext-1' });

  test('missing reference -> PENDING_REFERENCE', () => {
    expect(decide(reversal(), walletWith('0.00'), null)).toEqual({ type: 'PENDING_REFERENCE' });
  });
  test('reference still pending -> PENDING_REFERENCE', () => {
    expect(decide(reversal(), walletWith('0.00'), ref({ status: 'PENDING' }))).toEqual({ type: 'PENDING_REFERENCE' });
  });
  test('reference rejected/failed -> REFERENCE_NOT_PROCESSED', () => {
    expect(decide(reversal(), walletWith('0.00'), ref({ status: 'REJECTED' }))).toMatchObject({ code: 'REFERENCE_NOT_PROCESSED' });
    expect(decide(reversal(), walletWith('0.00'), ref({ status: 'FAILED' }))).toMatchObject({ code: 'REFERENCE_NOT_PROCESSED' });
  });

  test.each([
    ['provider', { providerId: 'x' }],
    ['player', { playerId: 'x' }],
    ['wallet', { walletId: 'x' }],
    ['currency', { currency: 'USD' }],
    ['round', { roundId: 'x' }],
    ['amount', { amount: brl('9.99') }],
  ] as const)('mismatch on %s -> REFERENCE_MISMATCH', (detail, over) => {
    expect(decide(reversal(), walletWith('0.00'), ref(over))).toEqual({ type: 'REJECT', code: 'REFERENCE_MISMATCH', detail });
  });

  test('refund of a BET credits the stake back', () => {
    expect(decide(reversal(), walletWith('0.00'), ref())).toEqual({ type: 'APPLY', direction: 'CREDIT', amount: brl('10.00') });
  });
  test('rollback of a WIN debits the win', () => {
    expect(decide(reversal('ROLLBACK'), walletWith('10.00'), ref({ kind: 'WIN' }))).toEqual({
      type: 'APPLY',
      direction: 'DEBIT',
      amount: brl('10.00'),
    });
  });
  test('reversing a WIN that would overdraw uses a distinct code', () => {
    expect(decide(reversal('ROLLBACK'), walletWith('3.00'), ref({ kind: 'WIN' }))).toEqual({
      type: 'REJECT',
      code: 'REVERSAL_WOULD_OVERDRAW',
    });
  });
  test('LOSS, reversals and OPENING are not reversible', () => {
    for (const kind of ['LOSS', 'REFUND', 'ROLLBACK', 'OPENING'] as const) {
      expect(decide(reversal(), walletWith('0.00'), ref({ kind }))).toMatchObject({ code: 'REFERENCE_NOT_REVERSIBLE' });
    }
  });
  test('second reversal is blocked, same or different type', () => {
    expect(decide(reversal('REFUND'), walletWith('0.00'), ref({ reversedBy: ['REFUND'] }))).toMatchObject({ code: 'ALREADY_REVERSED' });
    expect(decide(reversal('ROLLBACK'), walletWith('0.00'), ref({ reversedBy: ['REFUND'] }))).toMatchObject({ code: 'ALREADY_REVERSED' });
  });
});

describe('applyDecision', () => {
  test('ledger rebuilt from entries matches balance after a sequence', () => {
    const w = walletWith('0.00');
    const steps: [string, TransactionInput][] = [
      ['t1', input({ kind: 'WIN', amount: brl('100.00') })],
      ['t2', input({ kind: 'BET', amount: brl('40.00') })],
      ['t3', input({ kind: 'BET', amount: brl('70.00') })], // rejected
      ['t4', input({ kind: 'LOSS', amount: brl('40.00') })],
    ];
    for (const [id, i] of steps) applyDecision(w, id, decide(i, w, null));
    expect(w.balance.toString()).toBe('60.00');
    expect(w.pendingEntries).toHaveLength(2);
    expect(balanceFromLedger('BRL', w.pendingEntries).equals(w.balance)).toBe(true);
  });
});

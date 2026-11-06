'use strict';
/*
 * Test console for the Wagering Processor. Plain browser JavaScript, no dependencies, same-origin requests only.
 * Everything that comes back from the API is rendered with textContent (via h()), never innerHTML: responses carry
 * strings chosen by whoever called the API (player ids, provider ids, ...), so they must never be parsed as HTML.
 */

// ───────────────────────── helpers ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const uid = (n = 8) => crypto.randomUUID().replace(/-/g, '').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds a DOM element. Children and `text` are always inserted as text nodes. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clear = (el) => el.replaceChildren();
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const badgeClass = (s) => (s === 202 ? 's202' : s >= 200 && s < 300 ? 's2' : s >= 400 && s < 500 ? 's4' : s >= 500 ? 's5' : 's0');
const addMoney = (amount, cents) => {
  const [w, f] = amount.split('.');
  const total = BigInt(w) * 100n + BigInt(f ?? '0') + BigInt(cents);
  return `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
};

const EXPLAIN = {
  200: 'Idempotent replay: the original result came back and nothing was booked again.',
  201: 'Processed now: the balance changed and one ledger entry was written.',
  202: 'Accepted, but waiting: a reversal whose original transaction has not arrived yet. A worker retries with backoff.',
  400: 'Invalid payload: it never reached the business rules.',
  401: 'Not authenticated: this server expects a valid bearer token.',
  403: 'Authenticated, but not allowed: the token lacks the role (or the provider) this call needs.',
  404: 'Not found.',
  409: 'Conflict: the same idempotency key / external id was used with a different payload, or the wallet already exists.',
  422: 'Business rejection: valid request, refused by the rules. Nothing was booked.',
  503: 'Temporary infrastructure failure: retry with the same idempotency key.',
};
const FAILURE = {
  INSUFFICIENT_FUNDS: 'The balance does not cover this bet.',
  REVERSAL_WOULD_OVERDRAW: 'Reversing a win that was already spent would make the balance negative.',
  ALREADY_REVERSED: 'This transaction was already reversed once (a refund or a rollback; never both).',
  REFERENCE_MISMATCH: 'The reversal does not match the transaction it references (amount, round, player, provider or currency).',
  REFERENCE_NOT_FOUND: 'The referenced transaction never arrived within the retry limit.',
  REFERENCE_NOT_PROCESSED: 'The referenced transaction exists but was never processed.',
  REFERENCE_NOT_REVERSIBLE: 'Only a BET or a WIN can be reversed.',
  CURRENCY_MISMATCH: 'The currency differs from the wallet currency.',
  WALLET_PLAYER_MISMATCH: 'The player does not own this wallet.',
  INVALID_AMOUNT: 'The amount must be greater than zero for this kind.',
};

// ───────────────────────── state ─────────────────────────
const state = {
  token: '',
  wallet: null, // { walletId, playerId, currency }
  lastTx: null, // { body, headers }
  ledgerCursor: null,
  logCount: 0,
};

// ───────────────────────── api client + log ─────────────────────────
async function api(method, path, { body, headers = {}, silent = false } = {}) {
  const corr = `ui-${uid(8)}`;
  const reqHeaders = { 'x-correlation-id': corr, ...headers };
  if (body !== undefined) reqHeaders['content-type'] = 'application/json';
  if (state.token) reqHeaders.authorization = 'Bearer ' + state.token;
  const t0 = performance.now();
  let res = null;
  let text = '';
  let error = null;
  try {
    res = await fetch(path, { method, headers: reqHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    text = await res.text();
  } catch (e) {
    error = String(e);
  }
  const ms = Math.round(performance.now() - t0);
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON (e.g. /metrics) */
  }
  const out = { method, path, status: res ? res.status : 0, ms, corr, data, error, retryAfter: res?.headers.get('retry-after') ?? null };
  if (out.status === 401) $('#auth-banner').hidden = false;
  if (!silent) logRequest(out, body, { ...reqHeaders, authorization: reqHeaders.authorization ? 'Bearer …' : undefined });
  return out;
}

function logRequest(r, body, headers) {
  const box = $('#log');
  $('.empty', box)?.remove();
  const flags = [];
  if (r.data && r.data.idempotentReplay === true) flags.push(h('span', { class: 'tag', text: 'replay' }));
  if (r.data && r.data.failureCode) flags.push(h('span', { class: 'tag', text: r.data.failureCode }));
  const row = h(
    'details',
    {},
    h(
      'summary',
      {},
      h('span', { class: 'badge ' + badgeClass(r.status), text: r.status || 'ERR' }),
      h('span', { class: 'mono', text: r.method }),
      h('span', { class: 'path', text: r.path }),
      ...flags,
      h('span', { class: 'muted small', text: `${r.ms} ms` }),
      h('span', { class: 'muted small mono', text: r.corr }),
    ),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'muted small', text: 'request' }),
      h('pre', { text: pretty({ headers, body: body ?? null }) }),
      h('div', { class: 'muted small', text: 'response' }),
      h('pre', { text: r.error ? r.error : pretty(r.data) }),
    ),
  );
  box.prepend(row);
  state.logCount++;
  while (box.children.length > 200) box.lastChild.remove();
}

// ───────────────────────── result card ─────────────────────────
function showResult(container, r) {
  clear(container);
  container.hidden = false;
  const d = r.data && typeof r.data === 'object' ? r.data : null;
  const code = d?.failureCode ?? d?.error?.code;
  // Node.append(null) would write the text "null": drop the empty slots explicitly.
  const parts = [
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'badge ' + badgeClass(r.status), text: r.status || 'network error' }),
      d?.status ? h('span', { class: 'tag', text: d.status }) : null,
      d?.idempotentReplay === true ? h('span', { class: 'tag', text: 'idempotent replay' }) : null,
      code ? h('span', { class: 'tag', text: code }) : null,
      h('span', { class: 'muted small', text: `${r.ms} ms · ${r.corr}` }),
    ),
    h('p', { text: r.error ? 'The request did not reach the server: ' + r.error : EXPLAIN[r.status] ?? '' }),
    FAILURE[code] ? h('p', { class: 'muted', text: FAILURE[code] }) : null,
    r.retryAfter ? h('p', { class: 'muted small', text: `Retry-After: ${r.retryAfter}s` }) : null,
    h('pre', { text: pretty(r.data ?? r.error) }),
  ];
  container.append(...parts.filter(Boolean));
}

// ───────────────────────── health chips ─────────────────────────
function setChip(id, up, text) {
  const chip = $(id);
  chip.classList.toggle('up', up === true);
  chip.classList.toggle('down', up === false);
  $('b', chip).textContent = text;
}
async function pollHealth() {
  const [live, ready] = await Promise.all([api('GET', '/health/live', { silent: true }), api('GET', '/health/ready', { silent: true })]);
  setChip('#chip-live', live.status === 200, live.status === 200 ? 'up' : 'down');
  setChip('#chip-ready', ready.status === 200, ready.status === 200 ? 'up' : 'down');
  const checks = ready.data?.checks;
  setChip('#chip-pg', checks ? checks.postgres === 'up' : ready.status === 200, checks ? checks.postgres : ready.status === 200 ? 'up' : '?');
  setChip('#chip-sqs', checks ? checks.sqs === 'up' : ready.status === 200, checks ? checks.sqs : ready.status === 200 ? 'up' : '?');
}

// ───────────────────────── wallet ─────────────────────────
const newPlayerId = () => `player-${uid(6)}`;

function showWallet(w) {
  $('#wallet-view').hidden = false;
  $('#wv-balance').textContent = w.balance;
  $('#wv-currency').textContent = w.currency;
  $('#wv-id').textContent = w.walletId;
  $('#wv-player').textContent = w.playerId;
  $('#wv-version').textContent = String(w.version);
  $('#wv-flag').textContent = w.flaggedAt ? `FLAGGED at ${w.flaggedAt}` : 'no';
}

async function refreshWallet() {
  if (!state.wallet) return;
  const r = await api('GET', `/wallets/${state.wallet.walletId}`);
  if (r.status === 200) showWallet(r.data);
  else $('#wv-balance').textContent = r.status === 403 ? '(no wallet:read role)' : '?';
  return r;
}

async function loadLedger(reset) {
  if (!state.wallet) return;
  if (reset) {
    state.ledgerCursor = null;
    clear($('#ledger tbody'));
  }
  const q = new URLSearchParams({ limit: '10' });
  if (state.ledgerCursor) q.set('cursor', state.ledgerCursor);
  const r = await api('GET', `/wallets/${state.wallet.walletId}/ledger?${q}`);
  const empty = $('#ledger-empty');
  if (r.status !== 200) {
    empty.textContent = r.status === 403 ? 'The token has no wallet:read role, so the ledger cannot be shown.' : `Could not load the ledger (${r.status}).`;
    return;
  }
  const tbody = $('#ledger tbody');
  for (const e of r.data.items) {
    const n = tbody.children.length + 1;
    tbody.append(
      h(
        'tr',
        {},
        h('td', { text: n }),
        h('td', { class: e.direction === 'CREDIT' ? 'credit' : 'debit', text: e.direction }),
        h('td', { class: 'num', text: e.amount }),
        h('td', { class: 'num', text: e.balanceAfter }),
        h('td', { class: 'mono', text: e.transactionId.slice(0, 8) }),
        h('td', { class: 'muted', text: new Date(e.createdAt).toLocaleTimeString() }),
      ),
    );
  }
  state.ledgerCursor = r.data.nextCursor;
  $('#ledger-more').hidden = !r.data.nextCursor;
  empty.textContent = tbody.children.length ? '' : 'No entries yet (a LOSS or a rejected bet does not create one).';
}

async function refreshAll() {
  await refreshWallet();
  await loadLedger(true);
}

$('#wallet-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = { playerId: $('#w-player').value.trim(), currency: $('#w-currency').value.trim().toUpperCase() };
  const opening = $('#w-opening').value.trim();
  if (opening) body.openingCredit = opening;
  const r = await api('POST', '/wallets', { body });
  if (r.status === 201) {
    state.wallet = { walletId: r.data.walletId, playerId: r.data.playerId, currency: r.data.currency };
    showWallet(r.data);
    $('#wv-recon').hidden = true;
    await loadLedger(true);
    $('#t-ref').value = '';
  } else {
    // show the failure next to the form, reusing the wallet panel's result area
    const box = $('#wv-recon');
    $('#wallet-view').hidden = !state.wallet;
    showResult(box, r);
    box.hidden = false;
    $('#wallet-view').hidden = false;
  }
});
$('#w-new-player').addEventListener('click', () => ($('#w-player').value = newPlayerId()));
$('#wv-refresh').addEventListener('click', refreshAll);
$('#wv-reconcile').addEventListener('click', async () => {
  if (!state.wallet) return;
  const r = await api('POST', `/wallets/${state.wallet.walletId}/reconciliation`);
  const box = $('#wv-recon');
  clear(box);
  box.hidden = false;
  if (r.status !== 200) return showResult(box, r);
  const d = r.data;
  box.append(
    h('div', { class: 'head' }, h('span', { class: 'badge ' + (d.divergent ? 's4' : 's2'), text: d.divergent ? 'DIVERGENT' : 'consistent' })),
    h('p', { text: `stored balance ${d.storedBalance} · ledger-derived ${d.calculatedBalance} · version ${d.storedVersion} · ${d.ledgerEntries} ledger entries` }),
    ...d.differences.map((x) => h('p', { class: 'muted', text: x })),
  );
});

// ───────────────────────── transaction form ─────────────────────────
const isReversal = () => ['REFUND', 'ROLLBACK'].includes($('#t-kind').value);
const newExt = () => ($('#t-ext').value = `ext-${uid(6)}`);

function syncKind() {
  $('#t-ref-wrap').hidden = !isReversal();
  if (isReversal() && !$('#t-ref').value && state.lastRef) $('#t-ref').value = state.lastRef;
}
$('#t-kind').addEventListener('change', syncKind);
$('#t-ext-new').addEventListener('click', newExt);

function buildTx() {
  const body = {
    providerId: $('#t-provider').value.trim(),
    externalTransactionId: $('#t-ext').value.trim(),
    kind: $('#t-kind').value,
    playerId: state.wallet.playerId,
    currency: state.wallet.currency,
    amount: $('#t-amount').value.trim(),
  };
  const round = $('#t-round').value.trim();
  if (round) body.roundId = round;
  if (isReversal()) body.referenceExternalId = $('#t-ref').value.trim();
  const headers = {};
  const idem = $('#t-idem').value.trim();
  if (idem) headers['idempotency-key'] = idem;
  return { body, headers };
}

async function submitTx({ body, headers }) {
  const r = await api('POST', '/wagering/transactions', { body, headers });
  showResult($('#tx-result'), r);
  if (r.status === 201 || r.status === 202 || r.status === 422) {
    if (body.kind === 'BET' || body.kind === 'WIN') state.lastRef = body.externalTransactionId;
  }
  await refreshAll();
  return r;
}

$('#tx-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!state.wallet) {
    showResult($('#tx-result'), { status: 0, ms: 0, corr: '', error: 'Create a wallet first (step 1).', data: null });
    return;
  }
  const tx = buildTx();
  state.lastTx = tx;
  $('#t-replay').disabled = false;
  $('#t-conflict').disabled = false;
  await submitTx(tx);
  newExt(); // the next click is a NEW transaction; use "Replay" to resend this one
  syncKind();
});
$('#t-replay').addEventListener('click', () => state.lastTx && submitTx(state.lastTx));
$('#t-conflict').addEventListener('click', () => {
  if (!state.lastTx) return;
  const changed = { ...state.lastTx, body: { ...state.lastTx.body, amount: addMoney(state.lastTx.body.amount, 100) } };
  return submitTx(changed);
});

// ───────────────────────── scenarios ─────────────────────────
const PROVIDER = 'acme';

async function scenarioWallet(opening) {
  const playerId = newPlayerId();
  const r = await api('POST', '/wallets', { body: { playerId, currency: 'BRL', openingCredit: opening } });
  if (r.status !== 201) throw new Error(`could not create the wallet (${r.status}: ${r.data?.error?.message ?? r.error ?? ''})`);
  return { walletId: r.data.walletId, playerId, currency: 'BRL' };
}
const txBody = (w, kind, amount, ext = `ext-${uid(6)}`, ref) => ({
  providerId: PROVIDER, externalTransactionId: ext, kind, playerId: w.playerId, currency: w.currency, amount, roundId: 'r1',
  ...(ref ? { referenceExternalId: ref } : {}),
});
const post = (body) => api('POST', '/wagering/transactions', { body });
const count = (rs, status) => rs.filter((r) => r.status === status).length;

const SCENARIOS = [
  {
    title: 'Same bet, 10 times at once',
    blurb: 'Ten identical requests in parallel (a provider retrying aggressively). Idempotency must book it exactly once.',
    async run(c) {
      const w = await c.wallet('100.00');
      const body = txBody(w, 'BET', '10.00', `dup-${uid(6)}`);
      const rs = await Promise.all(Array.from({ length: 10 }, () => post(body)));
      c.info(`responses: ${count(rs, 201)}× 201 (processed), ${count(rs, 200)}× 200 (replay)`);
      c.check(count(rs, 201) === 1 && count(rs, 200) === 9, 'exactly one request booked the bet, the other nine got the stored result');
      c.check(new Set(rs.map((r) => r.data?.transactionId)).size === 1, 'all ten responses name the same transaction id');
      await c.balance(w, '90.00', 'balance is 90.00: debited once, not ten times');
      await c.reconcile(w);
    },
  },
  {
    title: 'Twenty bets fighting for 10.00',
    blurb: 'Twenty parallel 1.00 bets on a wallet with 10.00. The wallet row lock must let exactly ten through, never overdraw.',
    async run(c) {
      const w = await c.wallet('10.00');
      const rs = await Promise.all(Array.from({ length: 20 }, () => post(txBody(w, 'BET', '1.00'))));
      c.info(`responses: ${count(rs, 201)}× 201 (processed), ${count(rs, 422)}× 422 (rejected)`);
      c.check(count(rs, 201) === 10 && count(rs, 422) === 10, 'exactly ten bets were accepted and ten rejected');
      c.check(rs.filter((r) => r.status === 422).every((r) => r.data?.failureCode === 'INSUFFICIENT_FUNDS'), 'every rejection is INSUFFICIENT_FUNDS');
      await c.balance(w, '0.00', 'balance is 0.00 and never went negative');
      await c.reconcile(w);
    },
  },
  {
    title: 'Reversal arrives before its bet',
    blurb: 'A REFUND shows up first (messages can arrive out of order). It waits as PENDING_REFERENCE and is applied once the bet exists.',
    async run(c) {
      const w = await c.wallet('50.00');
      const betExt = `bet-${uid(6)}`;
      const refund = await post(txBody(w, 'REFUND', '10.00', `refund-${uid(6)}`, betExt));
      c.check(refund.status === 202 && refund.data?.status === 'PENDING_REFERENCE', 'the refund is accepted but parked (202 PENDING_REFERENCE)');
      c.info(`next retry planned at ${refund.data?.nextRetryAt ?? '?'}`);
      const bet = await post(txBody(w, 'BET', '10.00', betExt));
      c.check(bet.status === 201, 'the bet arrives and is processed (201)');
      let tx = null;
      for (let i = 0; i < 50; i++) {
        const r = await api('GET', `/wagering/transactions/${refund.data.transactionId}`, { silent: true });
        tx = r.data;
        if (r.status !== 200 || tx.status !== 'PENDING_REFERENCE') break;
        await sleep(500);
      }
      c.check(tx?.status === 'PROCESSED', `a background worker applied the refund (status ${tx?.status}, after ${tx?.retryCount ?? '?'} scheduled retries)`);
      await c.balance(w, '50.00', 'balance is back to 50.00 (opening 50 − bet 10 + refund 10)');
      await c.reconcile(w);
    },
  },
  {
    title: 'A bet can be reversed only once',
    blurb: 'Refund a bet, then try to roll it back too. Returning the stake twice would be creating money.',
    async run(c) {
      const w = await c.wallet('50.00');
      const betExt = `bet-${uid(6)}`;
      c.check((await post(txBody(w, 'BET', '8.00', betExt))).status === 201, 'bet of 8.00 processed');
      c.check((await post(txBody(w, 'REFUND', '8.00', `r1-${uid(6)}`, betExt))).status === 201, 'refund processed (201)');
      const second = await post(txBody(w, 'ROLLBACK', '8.00', `r2-${uid(6)}`, betExt));
      c.check(second.status === 422 && second.data?.failureCode === 'ALREADY_REVERSED', 'the rollback is rejected: 422 ALREADY_REVERSED');
      await c.balance(w, '50.00', 'balance is 50.00: the stake came back once');
      await c.reconcile(w);
    },
  },
  {
    title: 'Reversing a win that was already spent',
    blurb: 'Win 5.00, spend everything, then roll the win back. That would drive the balance below zero, so it is refused.',
    async run(c) {
      const w = await c.wallet('10.00');
      const winExt = `win-${uid(6)}`;
      c.check((await post(txBody(w, 'WIN', '5.00', winExt))).status === 201, 'win of 5.00 processed (balance 15.00)');
      c.check((await post(txBody(w, 'BET', '15.00'))).status === 201, 'bet of 15.00 processed (balance 0.00)');
      const rb = await post(txBody(w, 'ROLLBACK', '5.00', `rb-${uid(6)}`, winExt));
      c.check(rb.status === 422 && rb.data?.failureCode === 'REVERSAL_WOULD_OVERDRAW', 'the rollback is rejected: 422 REVERSAL_WOULD_OVERDRAW');
      await c.balance(w, '0.00', 'balance stays 0.00');
      await c.reconcile(w);
    },
  },
  {
    title: 'Same id, different amount',
    blurb: 'Reusing a transaction id with a different payload is a client bug, not a retry: it must be refused, not silently accepted.',
    async run(c) {
      const w = await c.wallet('100.00');
      const ext = `id-${uid(6)}`;
      c.check((await post(txBody(w, 'BET', '10.00', ext))).status === 201, 'first bet (10.00) processed');
      const again = await post(txBody(w, 'BET', '10.00', ext));
      c.check(again.status === 200 && again.data?.idempotentReplay === true, 'the identical resend is a replay (200, idempotentReplay: true)');
      const clash = await post(txBody(w, 'BET', '99.00', ext));
      c.check(clash.status === 409, 'the same id with another amount is refused: 409');
      await c.balance(w, '90.00', 'balance is 90.00: only the first bet counted');
      await c.reconcile(w);
    },
  },
];

function buildScenarioCard(s) {
  const steps = h('ol', { class: 'steps' });
  const verdict = h('div', { class: 'verdict', hidden: true });
  const button = h('button', { type: 'button', text: 'Run' });
  const card = h('div', { class: 'scn' }, h('h3', { text: s.title }), h('p', { text: s.blurb }), h('div', {}, button), steps, verdict);

  const add = (kind, text) => steps.append(h('li', { class: kind }, h('span', { class: 'mark', text: { pass: '✓', fail: '✗', info: '•' }[kind] }), h('span', { text })));
  let failed = false;
  const ctx = {
    info: (t) => add('info', t),
    check(ok, text) {
      if (!ok) failed = true;
      add(ok ? 'pass' : 'fail', text);
    },
    last: null,
    wallet: async (opening) => {
      const w = await scenarioWallet(opening);
      ctx.last = w;
      add('info', `created wallet for ${w.playerId} with ${opening}`);
      return w;
    },
    async balance(w, expected, text) {
      const r = await api('GET', `/wallets/${w.walletId}`);
      if (r.status !== 200) return add('info', `balance check skipped (${r.status}: the token may lack wallet:read)`);
      ctx.check(r.data.balance === expected, `${text} (got ${r.data.balance})`);
    },
    async reconcile(w) {
      const r = await api('POST', `/wallets/${w.walletId}/reconciliation`);
      if (r.status !== 200) return add('info', `ledger check skipped (${r.status}: the token may lack wallet:reconcile)`);
      ctx.check(!r.data.divergent, `ledger agrees with the balance (stored ${r.data.storedBalance}, rebuilt from ${r.data.ledgerEntries} entries ${r.data.calculatedBalance})`);
    },
  };

  button.addEventListener('click', async () => {
    clear(steps);
    verdict.hidden = true;
    failed = false;
    button.disabled = true;
    button.textContent = 'Running…';
    try {
      await s.run(ctx);
    } catch (e) {
      failed = true;
      add('fail', `stopped: ${e.message}`);
    }
    verdict.hidden = false;
    verdict.className = 'verdict ' + (failed ? 'fail' : 'pass');
    verdict.textContent = failed ? '✗ something unexpected happened' : '✓ behaved as designed';
    button.disabled = false;
    button.textContent = 'Run again';
    // Put the scenario's wallet in panels 1 and 3, so its balance and ledger can be inspected, and refresh the tiles.
    if (ctx.last) {
      state.wallet = ctx.last;
      state.lastRef = null;
      $('#wv-recon').hidden = true;
      await refreshAll();
      $('#wv-flag').parentElement.scrollIntoView?.({ block: 'nearest' });
    }
    pollMetrics();
  });
  return card;
}
for (const s of SCENARIOS) $('#scenarios').append(buildScenarioCard(s));

// ───────────────────────── metrics ─────────────────────────
function parseProm(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(-?[\d.]+(?:e[+-]?\d+)?)$/.exec(line);
    if (m) out.push({ name: m[1], labels: m[2] ?? '', value: Number(m[3]) });
  }
  return out;
}
const sumOf = (rows, name, labelPart) => rows.filter((r) => r.name === name && (!labelPart || r.labels.includes(labelPart))).reduce((s, r) => s + r.value, 0);

const TILES = [
  { id: 'processed', label: 'processed', get: (m) => sumOf(m, 'wager_transactions_total', 'status="PROCESSED"'), counter: true },
  { id: 'rejected', label: 'rejected (business)', get: (m) => sumOf(m, 'wager_transactions_total', 'status="REJECTED"'), counter: true },
  { id: 'pendingq', label: 'waiting for reference now', get: (m) => sumOf(m, 'pending_reference_transactions') },
  { id: 'dups', label: 'duplicates absorbed', get: (m) => sumOf(m, 'wager_duplicates_total'), counter: true },
  { id: 'locks', label: 'wallet lock conflicts', get: (m) => sumOf(m, 'wallet_lock_conflicts_total'), counter: true },
  { id: 'outbox', label: 'outbox events unpublished', get: (m) => sumOf(m, 'outbox_unpublished_events') },
  { id: 'lag', label: 'outbox lag (s)', get: (m) => sumOf(m, 'outbox_lag_seconds') },
  { id: 'auth', label: 'auth rejections', get: (m) => sumOf(m, 'auth_failures_total'), counter: true },
];
const baseline = {};
const tileEls = {};
for (const t of TILES) {
  const v = h('div', { class: 'v', text: '–' });
  const d = h('div', { class: 'd' });
  tileEls[t.id] = { v, d };
  $('#tiles').append(h('div', { class: 'tile' }, v, d, h('div', { class: 'l', text: t.label })));
}
async function pollMetrics() {
  const r = await api('GET', '/metrics', { silent: true });
  if (r.status !== 200 || typeof r.data !== 'string') return;
  const rows = parseProm(r.data);
  for (const t of TILES) {
    const value = t.get(rows);
    baseline[t.id] ??= value;
    tileEls[t.id].v.textContent = String(Math.round(value * 100) / 100);
    tileEls[t.id].d.textContent = t.counter && value - baseline[t.id] > 0 ? `+${value - baseline[t.id]} since opened` : '';
  }
}

// ───────────────────────── wiring ─────────────────────────
$('#token').addEventListener('input', (e) => (state.token = e.target.value.trim()));
$('#token-clear').addEventListener('click', () => {
  $('#token').value = '';
  state.token = '';
  $('#auth-banner').hidden = true;
});
$('#log-clear').addEventListener('click', () => {
  const box = $('#log');
  clear(box);
  box.append(h('div', { class: 'empty', text: 'No requests yet.' }));
});
$('#log').append(h('div', { class: 'empty', text: 'No requests yet.' }));

$('#w-player').value = newPlayerId();
newExt();
syncKind();
pollHealth();
pollMetrics();
setInterval(pollHealth, 5000);
setInterval(() => $('#m-live').checked && pollMetrics(), 2000);

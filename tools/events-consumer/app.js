'use strict';
/* Events consumer page. Every value from the stream is inserted as text (h() uses textContent), never as markup. */

const $ = (s) => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const TILES = [
  { id: 'received', label: 'messages received' },
  { id: 'unique', label: 'unique events', good: true },
  { id: 'duplicates', label: 'duplicates dropped' },
  { id: 'invalid', label: 'invalid messages', bad: true },
  { id: 'outOfOrder', label: 'out-of-order versions', bad: true },
];
const tileEls = {};
for (const t of TILES) {
  const v = h('div', { class: 'v', text: '0' });
  const el = h('div', { class: 'tile' }, v, h('div', { class: 'l', text: t.label }));
  tileEls[t.id] = { v, el, t };
  $('#tiles').append(el);
}
const byType = h('div', { class: 'tile types' }, h('div', { class: 'v', text: '–' }), h('div', { class: 'l', text: 'by type' }));
$('#tiles').append(byType);

let last = 0;

function summary(e) {
  const d = e.data ?? {};
  if (e.eventType === 'WalletBalanceChanged') return `${d.direction} ${d.money?.amount} (${d.balanceBefore?.amount} → ${d.balanceAfter?.amount}, wallet v${d.walletVersion})`;
  if (e.eventType === 'WagerTransactionRejected') return `${d.kind} ${d.money?.amount} rejected: ${d.failureCode}`;
  if (d.kind) return `${d.kind} ${d.money?.amount ?? ''} ${d.money?.currency ?? ''}${d.gameId ? ' · ' + d.gameId : ''}`.trim();
  return e.reason ?? '';
}

function row(e) {
  const tags = [];
  tags.push(h('span', { class: 'tag ' + (e.status === 'duplicate' ? 'dup' : e.status === 'invalid' ? 'bad' : 'new'), text: e.status }));
  if (e.outOfOrder) tags.push(h('span', { class: 'tag bad', text: 'out of order' }));
  return h(
    'details',
    {},
    h(
      'summary',
      {},
      h('span', { class: 'muted small mono', text: new Date(e.receivedAt).toLocaleTimeString() }),
      ...tags,
      h('b', { text: e.eventType ?? '(invalid)' }),
      h('span', { class: 'grow muted', text: summary(e) }),
      h('span', { class: 'muted small mono', text: (e.aggregateId ?? '').slice(0, 8) }),
    ),
    h('pre', { text: JSON.stringify(e, null, 2) }),
  );
}

async function poll() {
  let res;
  try {
    res = await fetch(`/api/events?since=${last}`, { cache: 'no-store' });
  } catch {
    return;
  }
  if (!res.ok) return;
  const { stats, events } = await res.json();
  // The key is the metric name; the entry holds only the DOM nodes and the tile definition.
  for (const [id, { el, t }] of Object.entries(tileEls)) {
    const value = stats[id] ?? 0;
    el.querySelector('.v').textContent = String(value);
    el.classList.toggle('bad', Boolean(t.bad) && value > 0);
    el.classList.toggle('good', Boolean(t.good) && value > 0);
  }
  byType.querySelector('.v').replaceChildren(
    ...(Object.entries(stats.byType).length
      ? Object.entries(stats.byType).map(([k, v]) => h('div', { text: `${k.replace(/^(Wager|Wallet)/, '')}: ${v}` }))
      : [document.createTextNode('–')]),
  );
  if (events.length) {
    $('#list .empty')?.remove();
    for (const e of [...events].reverse()) $('#list').prepend(row(e)); // events arrive newest first; keep that order
    last = Math.max(last, ...events.map((e) => e.n));
    while ($('#list').children.length > 300) $('#list').lastChild.remove();
  }
}

$('#list').append(h('div', { class: 'empty', text: 'Nothing yet: make some transactions in the test console.' }));
$('#clear').addEventListener('click', () => {
  $('#list').replaceChildren(h('div', { class: 'empty', text: 'Cleared (new events will appear here).' }));
});
poll();
setInterval(() => $('#live').checked && poll(), 1000);

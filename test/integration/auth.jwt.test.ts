import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { MetricsService } from '../../src/infrastructure/observability/metrics.service';
import { bootApp, uid, type TestApp } from './helpers';
import { FakeIdp } from './fixtures/fake-idp';

let idp: FakeIdp;
let t: TestApp;
let metrics: MetricsService;

const authEnv = (i: FakeIdp, extra: Record<string, string> = {}) => ({
  AUTH_MODE: 'jwt',
  AUTH_ISSUER: i.issuer,
  AUTH_AUDIENCE: 'wagering-api',
  AUTH_ALLOW_INSECURE_ISSUER: 'true', // the fake IdP is plain http on localhost
  AUTH_JWKS_COOLDOWN_MS: '200',
  AUTH_JWKS_TIMEOUT_MS: '1500',
  ...extra,
});

beforeAll(async () => {
  idp = await FakeIdp.start();
  t = await bootApp(authEnv(idp));
  metrics = t.app.get(MetricsService);
}, 30000);

afterAll(async () => {
  await t.close();
  idp.stop();
});

async function call(app: TestApp, method: string, path: string, token?: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  return { status: res.status, headers: res.headers, body: text && isJson ? (JSON.parse(text) as Record<string, any>) : null };
}

const adminToken = () => idp.sign({ claims: { roles: ['admin'] } });

async function walletFor(app: TestApp = t) {
  const playerId = uid('player');
  const r = await call(app, 'POST', '/wallets', await adminToken(), { playerId, currency: 'BRL', openingCredit: '100.00' });
  expect(r.status).toBe(201);
  return { playerId, walletId: r.body!.walletId as string, currency: 'BRL' };
}

const bet = (w: { playerId: string; currency: string }, providerId = 'prov-a', over: Record<string, unknown> = {}) => ({
  providerId,
  externalTransactionId: uid('ext'),
  kind: 'BET',
  playerId: w.playerId,
  currency: w.currency,
  amount: '1.00',
  roundId: 'r1',
  ...over,
});

const reasons = (r: string) => metrics.get('auth_failures_total', { reason: r });

describe('authentication: what a bad token looks like', () => {
  test('no token: 401 with a WWW-Authenticate challenge and a stable error code', async () => {
    const before = reasons('missing_token');
    const r = await call(t, 'GET', `/wallets/${randomUUID()}`);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect(r.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(reasons('missing_token')).toBe(before + 1);
  });

  test('a valid token works', async () => {
    const w = await walletFor();
    const r = await call(t, 'GET', `/wallets/${w.walletId}`, await adminToken());
    expect(r.status).toBe(200);
    expect(r.body!.balance).toBe('100.00');
  });

  test.each([
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['empty bearer', 'Bearer '],
    ['two tokens', 'Bearer aaa.bbb.ccc ddd.eee.fff'],
    ['junk', 'Bearer not-a-jwt'],
    ['control characters', 'Bearer abc\u0001def'],
  ])('malformed credentials (%s) are rejected with 401', async (_name, header) => {
    const res = await fetch(`${t.url}/wallets/${randomUUID()}`, { headers: { authorization: header } }).catch(() => null);
    // The HTTP layer itself may refuse control characters (400) before the application sees them; what must never
    // happen is a success. Some clients refuse to send such a header at all (res === null).
    if (res) expect([400, 401]).toContain(res.status);
  });

  test('expired token', async () => {
    const before = reasons('expired');
    const r = await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ expiresIn: -60 }));
    expect(r.status).toBe(401);
    expect(reasons('expired')).toBe(before + 1);
  });

  test('a token inside the clock tolerance is still accepted, one far outside is not', async () => {
    const w = await walletFor();
    const admin = { roles: ['admin'] };
    expect((await call(t, 'GET', `/wallets/${w.walletId}`, await idp.sign({ claims: admin, expiresIn: -2 }))).status).toBe(200);
    expect((await call(t, 'GET', `/wallets/${w.walletId}`, await idp.sign({ claims: admin, expiresIn: -30 }))).status).toBe(401);
  });

  test('not yet valid (nbf in the future) and missing exp / sub are rejected', async () => {
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ notBefore: 3600 }))).status).toBe(401);
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ expiresIn: null }))).status).toBe(401);
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ omitSub: true }))).status).toBe(401);
  });

  test('wrong issuer and wrong audience', async () => {
    const iss = reasons('invalid_issuer');
    const aud = reasons('invalid_audience');
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ issuer: 'http://evil.example' }))).status).toBe(401);
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ audience: 'some-other-api' }))).status).toBe(401);
    expect(reasons('invalid_issuer')).toBe(iss + 1);
    expect(reasons('invalid_audience')).toBe(aud + 1);
  });

  test('signed by another key: with a known kid (forgery) and with an unknown kid', async () => {
    const forged = await generateKeyPair('RS256');
    const sig = reasons('invalid_signature');
    const forgedKnownKid = await idp.sign({ kid: 'key-1', signWith: forged.privateKey });
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, forgedKnownKid)).status).toBe(401);
    expect(reasons('invalid_signature')).toBe(sig + 1);

    const unknown = reasons('unknown_key');
    const entry = await idp.addKey('never-published-kid');
    // remove it again from the published set by signing with a kid the JWKS will never contain
    const token = await new SignJWT({ sub: 'u', roles: ['admin'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'ghost-kid' })
      .setIssuer(idp.issuer)
      .setAudience('wagering-api')
      .setExpirationTime('5m')
      .sign(entry.privateKey);
    expect((await call(t, 'GET', `/wallets/${randomUUID()}`, token)).status).toBe(401);
    expect(reasons('unknown_key')).toBeGreaterThanOrEqual(unknown + 1);
  });

  test('algorithm "none" is rejected', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: 'attacker', iss: idp.issuer, aud: 'wagering-api', exp: 9999999999, roles: ['admin'] })}.`;
    const r = await call(t, 'GET', `/wallets/${randomUUID()}`, token);
    expect(r.status).toBe(401);
  });

  test('algorithm confusion: HS256 signed with the PUBLIC key as the secret is rejected', async () => {
    const secret = new TextEncoder().encode(await idp.publicKeyPem());
    const before = reasons('algorithm_not_allowed');
    const token = await new SignJWT({ sub: 'attacker', roles: ['admin'] })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuer(idp.issuer)
      .setAudience('wagering-api')
      .setExpirationTime('5m')
      .sign(secret);
    const r = await call(t, 'GET', `/wallets/${randomUUID()}`, token);
    expect(r.status).toBe(401);
    expect(reasons('algorithm_not_allowed')).toBe(before + 1);
  });
});

describe('public endpoints stay open', () => {
  test('health probes and metrics need no token', async () => {
    for (const path of ['/health/live', '/health/ready', '/metrics']) {
      expect((await call(t, 'GET', path)).status).toBe(200);
    }
  });
});

describe('authorization: roles', () => {
  test('each endpoint needs its role; admin implies all', async () => {
    const w = await walletFor();
    const token = (roles: string[]) => idp.sign({ claims: { roles } });
    const probe = async (roles: string[], method: string, path: string, body?: unknown) =>
      (await call(t, method, path, await token(roles), body)).status;

    // submit-only caller (a game provider)
    expect(await probe(['wager:submit'], 'POST', '/wagering/transactions', bet(w))).toBe(201);
    expect(await probe(['wager:submit'], 'GET', `/wallets/${w.walletId}`)).toBe(403);
    expect(await probe(['wager:submit'], 'POST', '/wallets', { playerId: uid('p'), currency: 'BRL' })).toBe(403);
    expect(await probe(['wager:submit'], 'POST', `/wallets/${w.walletId}/reconciliation`)).toBe(403);

    // read-only caller
    expect(await probe(['wallet:read'], 'GET', `/wallets/${w.walletId}`)).toBe(200);
    expect(await probe(['wallet:read'], 'GET', `/wallets/${w.walletId}/ledger`)).toBe(200);
    expect(await probe(['wallet:read'], 'POST', '/wagering/transactions', bet(w))).toBe(403);
    expect(await probe(['wager:read'], 'GET', `/providers/prov-a/wagering/transactions/${uid('none')}`)).toBe(404); // allowed, just not found

    // wallet admin tasks
    expect(await probe(['wallet:write'], 'POST', '/wallets', { playerId: uid('p'), currency: 'BRL' })).toBe(201);
    expect(await probe(['wallet:reconcile'], 'POST', `/wallets/${w.walletId}/reconciliation`)).toBe(200);

    // no roles at all: authenticated but allowed nothing
    expect(await probe([], 'GET', `/wallets/${w.walletId}`)).toBe(403);
    // admin implies everything
    expect(await probe(['admin'], 'POST', '/wagering/transactions', bet(w))).toBe(201);
  });

  test('a 403 carries a stable code and is counted', async () => {
    const before = reasons('forbidden_role');
    const r = await call(t, 'GET', `/wallets/${randomUUID()}`, await idp.sign({ claims: { roles: ['wager:submit'] } }));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(reasons('forbidden_role')).toBe(before + 1);
  });

  test('roles are read from Keycloak-shaped and Zitadel-shaped tokens', async () => {
    const w = await walletFor();
    const keycloak = await idp.sign({
      claims: {
        realm_access: { roles: ['offline_access'] },
        resource_access: { 'wagering-api': { roles: ['wallet:read'] }, 'other-client': { roles: ['admin'] } },
      },
    });
    expect((await call(t, 'GET', `/wallets/${w.walletId}`, keycloak)).status).toBe(200);
    // the other client's admin role must NOT leak into this API
    const onlyOtherClient = await idp.sign({ claims: { resource_access: { 'other-client': { roles: ['admin'] } } } });
    expect((await call(t, 'GET', `/wallets/${w.walletId}`, onlyOtherClient)).status).toBe(403);

    const zitadel = await idp.sign({
      claims: { 'urn:zitadel:iam:org:project:roles': { 'wallet:read': { '123': 'acme.zitadel.cloud' } } },
    });
    expect((await call(t, 'GET', `/wallets/${w.walletId}`, zitadel)).status).toBe(200);
  });
});

describe('authorization: provider scoping', () => {
  test('a provider-scoped token can only act for its own provider', async () => {
    const w = await walletFor();
    const scoped = await idp.sign({ claims: { roles: ['wager:submit', 'wager:read'], provider_id: 'prov-a' } });

    const own = bet(w, 'prov-a');
    const ok = await call(t, 'POST', '/wagering/transactions', scoped, own);
    expect(ok.status).toBe(201);

    const before = reasons('forbidden_provider');
    const other = await call(t, 'POST', '/wagering/transactions', scoped, bet(w, 'prov-b'));
    expect(other.status).toBe(403);
    expect(reasons('forbidden_provider')).toBe(before + 1);

    // nothing was booked for the forbidden attempt
    const wallet = await call(t, 'GET', `/wallets/${w.walletId}`, await adminToken());
    expect(wallet.body!.balance).toBe('99.00'); // 100 - the single allowed 1.00 bet

    // reads: own provider ok, another provider's path forbidden
    expect((await call(t, 'GET', `/providers/prov-a/wagering/transactions/${own.externalTransactionId}`, scoped)).status).toBe(200);
    expect((await call(t, 'GET', `/providers/prov-b/wagering/transactions/${own.externalTransactionId}`, scoped)).status).toBe(403);
  });

  test("another provider's transaction looks like it does not exist (no disclosure by id)", async () => {
    const w = await walletFor();
    const b = bet(w, 'prov-b');
    const created = await call(t, 'POST', '/wagering/transactions', await adminToken(), b);
    expect(created.status).toBe(201);
    const id = created.body!.transactionId as string;

    const scopedA = await idp.sign({ claims: { roles: ['wager:read'], provider_id: 'prov-a' } });
    expect((await call(t, 'GET', `/wagering/transactions/${id}`, scopedA)).status).toBe(404);
    const scopedB = await idp.sign({ claims: { roles: ['wager:read'], provider_id: 'prov-b' } });
    expect((await call(t, 'GET', `/wagering/transactions/${id}`, scopedB)).status).toBe(200);
  });

  test('an unscoped token (no provider claim) may act for any provider', async () => {
    const w = await walletFor();
    const token = await idp.sign({ claims: { roles: ['wager:submit'] } });
    expect((await call(t, 'POST', '/wagering/transactions', token, bet(w, 'prov-x'))).status).toBe(201);
  });

  test('validation still comes first: a malformed body is 400 even with a valid token', async () => {
    const token = await idp.sign({ claims: { roles: ['wager:submit'] } });
    expect((await call(t, 'POST', '/wagering/transactions', token, { providerId: 'p' })).status).toBe(400);
  });
});

describe('the identity provider as a dependency', () => {
  test('key rotation: a token signed with a key published AFTER start-up is accepted once the cooldown allows a refetch', async () => {
    const own = await FakeIdp.start();
    const app = await bootApp(authEnv(own));
    try {
      expect((await call(app, 'GET', `/wallets/${randomUUID()}`, await own.sign({ claims: { roles: ['admin'] } }))).status).toBe(404); // key-1 cached
      await own.addKey('key-2');
      await Bun.sleep(300); // longer than AUTH_JWKS_COOLDOWN_MS
      const rotated = await own.sign({ kid: 'key-2', claims: { roles: ['admin'] } });
      expect((await call(app, 'GET', `/wallets/${randomUUID()}`, rotated)).status).toBe(404); // authenticated (404 = reached the handler)
    } finally {
      await app.close();
      own.stop();
    }
  });

  test('bad tokens cannot make the application hammer the identity provider', async () => {
    const own = await FakeIdp.start();
    const app = await bootApp(authEnv(own, { AUTH_JWKS_COOLDOWN_MS: '60000' }));
    try {
      await call(app, 'GET', `/wallets/${randomUUID()}`, await own.sign({ claims: { roles: ['admin'] } })); // primes the cache
      const baseline = own.jwksRequests;
      const key = await own.addKey('hidden');
      const ghost = await new SignJWT({ sub: 'x' })
        .setProtectedHeader({ alg: 'RS256', kid: 'unpublished' })
        .setIssuer(own.issuer)
        .setAudience('wagering-api')
        .setExpirationTime('5m')
        .sign(key.privateKey);
      for (let i = 0; i < 30; i++) expect((await call(app, 'GET', `/wallets/${randomUUID()}`, ghost)).status).toBe(401);
      expect(own.jwksRequests - baseline).toBeLessThanOrEqual(1); // the cooldown absorbed the other 29
    } finally {
      await app.close();
      own.stop();
    }
  });

  test('IdP down at first use: 503 (not 401), probes stay up, and it recovers when the IdP returns', async () => {
    const own = await FakeIdp.start();
    const port = own.port;
    const token = await own.sign({ claims: { roles: ['admin'] } });
    own.stop(); // the application will find nobody home
    const app = await bootApp(authEnv(own));
    try {
      const down = await call(app, 'GET', `/wallets/${randomUUID()}`, token);
      expect(down.status).toBe(503);
      expect(down.headers.get('retry-after')).toBe('1');
      expect(down.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
      expect(app.app.get(MetricsService).get('auth_failures_total', { reason: 'jwks_unavailable' })).toBeGreaterThanOrEqual(1);
      expect((await call(app, 'GET', '/health/live')).status).toBe(200); // the API itself is up

      own.listen(port); // same port: the issuer URL the app was configured with is reachable again
      expect((await call(app, 'GET', `/wallets/${randomUUID()}`, token)).status).toBe(404); // authenticated
    } finally {
      await app.close();
      own.stop();
    }
  });

  test('keys already cached keep working through an IdP outage', async () => {
    const own = await FakeIdp.start();
    const app = await bootApp(authEnv(own));
    try {
      const token = await own.sign({ claims: { roles: ['admin'] } });
      expect((await call(app, 'GET', `/wallets/${randomUUID()}`, token)).status).toBe(404);
      own.stop();
      expect((await call(app, 'GET', `/wallets/${randomUUID()}`, token)).status).toBe(404); // still validated from the cache
    } finally {
      await app.close();
      own.stop();
    }
  });

  test('a discovery document that names a different issuer is refused', async () => {
    const own = await FakeIdp.start();
    own.discoveryIssuerOverride = 'http://impostor.example';
    const app = await bootApp(authEnv(own));
    try {
      const r = await call(app, 'GET', `/wallets/${randomUUID()}`, await own.sign({ claims: { roles: ['admin'] } }));
      expect(r.status).toBe(503);
    } finally {
      await app.close();
      own.stop();
    }
  });

  test('an explicit AUTH_JWKS_URI skips discovery', async () => {
    const own = await FakeIdp.start();
    const app = await bootApp(authEnv(own, { AUTH_JWKS_URI: own.jwksUri }));
    try {
      await call(app, 'GET', `/wallets/${randomUUID()}`, await own.sign({ claims: { roles: ['admin'] } }));
      expect(own.discoveryRequests).toBe(0);
      expect(own.jwksRequests).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
      own.stop();
    }
  });
});

describe('start-up validation', () => {
  test('AUTH_MODE=jwt without an issuer refuses to start (never silently unauthenticated)', async () => {
    await expect(bootApp({ AUTH_MODE: 'jwt', AUTH_AUDIENCE: 'x' })).rejects.toThrow(/AUTH_ISSUER/);
  });
});

describe('logs', () => {
  test('the subject is in the audit trail; the token never is', async () => {
    const lines: string[] = [];
    const original = JsonLogger.write;
    JsonLogger.write = (l) => lines.push(l);
    t.app.useLogger(new JsonLogger('log'));
    try {
      const w = await walletFor();
      const token = await idp.sign({ claims: { roles: ['wager:submit'], provider_id: 'prov-a' }, kid: 'key-1' });
      const r = await call(t, 'POST', '/wagering/transactions', token, bet(w, 'prov-a'));
      expect(r.status).toBe(201);
      await call(t, 'POST', '/wagering/transactions', await idp.sign({ expiresIn: -600 }), bet(w)); // a rejected one too

      const all = lines.join('\n');
      expect(all).not.toContain(token);
      expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./); // no JWT-looking string at all
      const settled = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'wager_settled' && l.providerId === 'prov-a');
      expect(settled).toMatchObject({ subject: 'user-1', status: 'PROCESSED' });
    } finally {
      JsonLogger.write = original;
    }
  });
});

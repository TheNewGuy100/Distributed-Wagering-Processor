import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AUTHENTICATOR, type Authenticator } from '../../src/interfaces/http/auth/auth.port';
import { api, bootApp, createWallet, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await bootApp();
});
afterAll(() => t.close());

describe('authentication extension point', () => {
  test('default (noop) authenticator lets requests through', async () => {
    expect((await api(t, 'POST', '/wallets', { playerId: `p-${crypto.randomUUID()}`, currency: 'BRL' })).status).toBe(201);
  });

  test('a real authenticator can be plugged in: protected routes need it, probes and metrics stay open', async () => {
    const w = await createWallet(t, '10.00');
    const auth = t.app.get<Authenticator>(AUTHENTICATOR);
    const original = auth.authenticate;
    auth.authenticate = async (req) =>
      req.header('authorization') === 'Bearer good' ? { subject: 'svc', providerId: 'prov-a', roles: [] } : null;
    try {
      expect((await api(t, 'GET', `/wallets/${w.walletId}`)).status).toBe(401);
      expect((await api(t, 'POST', '/wagering/transactions', {})).status).toBe(401);
      expect((await api(t, 'GET', `/wallets/${w.walletId}`, undefined, { authorization: 'Bearer good' })).status).toBe(200);
      expect((await api(t, 'GET', '/health/live')).status).toBe(200);
      expect((await api(t, 'GET', '/health/ready')).status).toBe(200);
      expect((await fetch(`${t.url}/metrics`)).status).toBe(200);
    } finally {
      auth.authenticate = original;
    }
  });
});

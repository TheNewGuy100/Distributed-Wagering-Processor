import { describe, expect, test } from 'bun:test';
import { loadAuthConfig } from './auth.config';
import { extractProviderId, extractRoles } from './claims';

describe('loadAuthConfig', () => {
  test('defaults to no authentication and needs nothing else', () => {
    const c = loadAuthConfig({});
    expect(c.mode).toBe('none');
  });

  test('jwt mode requires issuer and audience (fail fast at start-up)', () => {
    expect(() => loadAuthConfig({ AUTH_MODE: 'jwt', AUTH_AUDIENCE: 'api' })).toThrow(/AUTH_ISSUER/);
    expect(() => loadAuthConfig({ AUTH_MODE: 'jwt', AUTH_ISSUER: 'https://idp' })).toThrow(/AUTH_AUDIENCE/);
    const ok = loadAuthConfig({ AUTH_MODE: 'jwt', AUTH_ISSUER: 'https://idp/realms/x', AUTH_AUDIENCE: 'api' });
    expect(ok).toMatchObject({ mode: 'jwt', clientId: 'api', providerClaim: 'provider_id', clockToleranceSeconds: 5 });
  });

  test('rejects an unknown mode', () => {
    expect(() => loadAuthConfig({ AUTH_MODE: 'basic' })).toThrow(/AUTH_MODE/);
  });

  test('refuses plain-http issuer or JWKS unless explicitly allowed', () => {
    const base = { AUTH_MODE: 'jwt', AUTH_AUDIENCE: 'api' };
    expect(() => loadAuthConfig({ ...base, AUTH_ISSUER: 'http://idp' })).toThrow(/https/);
    expect(() => loadAuthConfig({ ...base, AUTH_ISSUER: 'https://idp', AUTH_JWKS_URI: 'http://idp/keys' })).toThrow(/https/);
    expect(loadAuthConfig({ ...base, AUTH_ISSUER: 'http://localhost:8080', AUTH_ALLOW_INSECURE_ISSUER: 'true' }).mode).toBe('jwt');
  });

  test('only asymmetric algorithms are accepted (no none, no HMAC)', () => {
    const base = { AUTH_MODE: 'jwt', AUTH_AUDIENCE: 'api', AUTH_ISSUER: 'https://idp' };
    for (const bad of ['none', 'HS256', 'RS256,HS512', '']) {
      expect(() => loadAuthConfig({ ...base, AUTH_ALGORITHMS: bad })).toThrow(/AUTH_ALGORITHMS/);
    }
    expect(loadAuthConfig({ ...base, AUTH_ALGORITHMS: 'ES256, RS256' }).algorithms).toEqual(['ES256', 'RS256']);
  });
});

describe('claim mapping', () => {
  test('generic roles array', () => {
    expect(extractRoles({ roles: ['wager:submit', 'wallet:read'] })).toEqual(['wager:submit', 'wallet:read']);
  });

  test('Keycloak realm and client roles (client roles only for the configured client)', () => {
    const claims = {
      realm_access: { roles: ['offline_access', 'wallet:read'] },
      resource_access: { 'wagering-api': { roles: ['wager:submit'] }, other: { roles: ['admin'] } },
    };
    expect(extractRoles(claims, { clientId: 'wagering-api' }).sort()).toEqual(['offline_access', 'wager:submit', 'wallet:read']);
    expect(extractRoles(claims, { clientId: 'wagering-api' })).not.toContain('admin');
  });

  test('Zitadel project roles are keyed by role name', () => {
    const claims = {
      'urn:zitadel:iam:org:project:roles': { 'wager:submit': { orgid: 'acme.zitadel.cloud' } },
      'urn:zitadel:iam:org:project:12345:roles': { 'wallet:read': { orgid: 'acme.zitadel.cloud' } },
    };
    expect(extractRoles(claims).sort()).toEqual(['wager:submit', 'wallet:read']);
  });

  test('configurable extra claim (array or object keyed by role), de-duplicated, junk ignored', () => {
    expect(extractRoles({ custom: { perms: ['a', 'a', 1, null, { x: 1 }, 'b'] } }, { rolesClaim: 'custom.perms' })).toEqual(['a', 'b']);
    expect(extractRoles({ custom: { a: {}, b: {} } }, { rolesClaim: 'custom' }).sort()).toEqual(['a', 'b']);
    expect(extractRoles({ roles: 'admin' })).toEqual([]); // a string is not a role list
  });

  test('roles are capped', () => {
    const many = Array.from({ length: 500 }, (_, i) => `r${i}`);
    expect(extractRoles({ roles: many })).toHaveLength(100);
  });

  test('provider claim: non-empty string only; dot paths work', () => {
    expect(extractProviderId({ provider_id: 'acme' }, 'provider_id')).toBe('acme');
    expect(extractProviderId({ attrs: { provider: 'acme' } }, 'attrs.provider')).toBe('acme');
    for (const bad of [{}, { provider_id: '' }, { provider_id: '  ' }, { provider_id: 7 }, { provider_id: ['a'] }]) {
      expect(extractProviderId(bad, 'provider_id')).toBeNull();
    }
  });
});

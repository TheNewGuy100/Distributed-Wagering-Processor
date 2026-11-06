import type { JWTPayload } from 'jose';

const MAX_ROLES = 100;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const byPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

/**
 * Collects roles from the places identity providers put them:
 *  - `roles` (array): generic / Auth0-style
 *  - `realm_access.roles` and `resource_access.<clientId>.roles`: Keycloak realm and client roles
 *  - `urn:zitadel:iam:org:project:roles` and `urn:zitadel:iam:org:project:<id>:roles`: Zitadel (object keyed by role)
 *  - an extra dot-path configured with AUTH_ROLES_CLAIM (an array, or an object keyed by role)
 * Non-string entries are ignored; the result is de-duplicated and capped.
 */
export function extractRoles(claims: JWTPayload, opts: { clientId?: string; rolesClaim?: string } = {}): string[] {
  const found = new Set<string>();
  const add = (v: unknown) => {
    for (const r of strings(v)) found.add(r);
  };
  const addKeys = (v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) found.add(k);
  };

  add(claims.roles);
  add(byPath(claims, 'realm_access.roles'));
  if (opts.clientId) add(byPath(claims, `resource_access.${opts.clientId}.roles`));
  for (const [key, value] of Object.entries(claims)) {
    if (/^urn:zitadel:iam:org:project:(.+:)?roles$/.test(key)) addKeys(value);
  }
  if (opts.rolesClaim) {
    const extra = byPath(claims, opts.rolesClaim);
    add(extra);
    addKeys(extra);
  }
  return [...found].slice(0, MAX_ROLES);
}

/** The provider a token is scoped to, or null when the claim is absent or not a non-empty string. */
export function extractProviderId(claims: JWTPayload, providerClaim: string): string | null {
  const v = byPath(claims, providerClaim);
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

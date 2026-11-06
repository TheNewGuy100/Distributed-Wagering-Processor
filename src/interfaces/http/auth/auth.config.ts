export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

/** Asymmetric algorithms only: a JWKS publishes public keys, so HS* (shared secret) and `none` make no sense. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export interface AuthConfig {
  /** `none`: no authentication (default). `jwt`: bearer tokens validated against the identity provider's JWKS. */
  mode: 'none' | 'jwt';
  /** Expected `iss`, exactly as the IdP issues it (Keycloak: https://host/realms/<realm>; Zitadel: https://<domain>). */
  issuer: string;
  /** Expected `aud` (this API's identifier / client id at the IdP). */
  audience: string;
  /** Explicit JWKS URL; when absent it is discovered from `<issuer>/.well-known/openid-configuration`. */
  jwksUri: string | undefined;
  algorithms: string[];
  clockToleranceSeconds: number;
  /** Minimum time between JWKS refetches triggered by an unknown `kid` (rotation) so bad tokens cannot hammer the IdP. */
  jwksCooldownMs: number;
  jwksTimeoutMs: number;
  /** Claim holding the provider a token is scoped to (string). Absent claim = not provider-scoped. */
  providerClaim: string;
  /** Extra dot-path claim read for roles, besides the standard Keycloak/Zitadel locations. */
  rolesClaim: string | undefined;
  /** Client id used to read Keycloak client roles (`resource_access.<clientId>.roles`); defaults to the audience. */
  clientId: string;
}

const int = (v: string | undefined, d: number): number => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Reads and validates the settings; throws at start-up so a misconfigured deployment never runs unauthenticated by accident. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env.AUTH_MODE ?? 'none').toLowerCase();
  if (mode !== 'none' && mode !== 'jwt') {
    throw new Error(`AUTH_MODE must be "none" or "jwt" (got "${mode}")`);
  }

  const issuer = env.AUTH_ISSUER ?? '';
  const audience = env.AUTH_AUDIENCE ?? '';
  const algorithms = (env.AUTH_ALGORITHMS ?? 'RS256,PS256,ES256,EdDSA')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  if (mode === 'jwt') {
    if (!issuer) throw new Error('AUTH_ISSUER is required when AUTH_MODE=jwt');
    if (!audience) throw new Error('AUTH_AUDIENCE is required when AUTH_MODE=jwt');
    const bad = algorithms.filter((a) => !ALLOWED_ALGORITHMS.includes(a));
    if (bad.length > 0 || algorithms.length === 0) {
      throw new Error(`AUTH_ALGORITHMS must be a subset of ${ALLOWED_ALGORITHMS.join(',')} (got: ${bad.join(',') || 'empty'})`);
    }
    // Keys fetched over plain HTTP could be swapped by anyone on the path: refuse unless explicitly allowed.
    const insecure = [issuer, env.AUTH_JWKS_URI ?? ''].filter((u) => u && !u.startsWith('https://'));
    if (insecure.length > 0 && env.AUTH_ALLOW_INSECURE_ISSUER !== 'true') {
      throw new Error(
        'AUTH_ISSUER / AUTH_JWKS_URI must use https (set AUTH_ALLOW_INSECURE_ISSUER=true only for local development)',
      );
    }
  }

  return {
    mode,
    issuer,
    audience,
    jwksUri: env.AUTH_JWKS_URI || undefined,
    algorithms,
    clockToleranceSeconds: int(env.AUTH_CLOCK_TOLERANCE_SECONDS, 5),
    jwksCooldownMs: int(env.AUTH_JWKS_COOLDOWN_MS, 30_000),
    jwksTimeoutMs: int(env.AUTH_JWKS_TIMEOUT_MS, 3_000),
    providerClaim: env.AUTH_PROVIDER_CLAIM || 'provider_id',
    rolesClaim: env.AUTH_ROLES_CLAIM || undefined,
    clientId: env.AUTH_CLIENT_ID || audience,
  };
}

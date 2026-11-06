import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import type { MetricsService } from '../../../infrastructure/observability/metrics.service';
import type { Authenticator, Principal } from './auth.port';
import type { AuthConfig } from './auth.config';
import { extractProviderId, extractRoles } from './claims';

const MAX_TOKEN_LENGTH = 8 * 1024;

type Jwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * Validates `Authorization: Bearer <jwt>` against an external identity provider (Keycloak, Zitadel, any OIDC IdP).
 * There is no user table: identity, passwords and key management stay at the IdP.
 *
 * What is checked: the signature (public key found by `kid` in the IdP's JWKS, algorithms restricted to an asymmetric
 * allow-list so `none` and HMAC-with-the-public-key confusion are impossible), `iss`, `aud`, `exp` (with a small clock
 * tolerance) and the presence of `sub`. Anything wrong with the TOKEN yields `null` (the guard answers 401); a problem
 * reaching the IdP throws 503, because failing closed on an outage is right but "your token is bad" would be a lie.
 * Tokens and claims are never logged.
 */
export class JwtAuthenticator implements Authenticator {
  private readonly logger = new Logger('Auth');
  private jwks: Promise<Jwks> | undefined;

  constructor(
    private readonly config: AuthConfig,
    private readonly metrics: MetricsService,
  ) {
    this.metrics.describe('auth_failures_total', 'Rejected requests by reason (authentication and authorization)');
  }

  async authenticate(req: Request): Promise<Principal | null> {
    const token = this.bearer(req.headers.authorization);
    if (token === null) return this.reject('missing_token');
    if (token === 'malformed') return this.reject('malformed_token');

    const jwks = await this.keys();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockToleranceSeconds,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (e) {
      return this.classify(e);
    }

    return {
      subject: payload.sub!,
      providerId: extractProviderId(payload, this.config.providerClaim),
      roles: extractRoles(payload, { clientId: this.config.clientId, rolesClaim: this.config.rolesClaim }),
    };
  }

  /** `null`: no credentials; 'malformed': credentials present but not a single well-formed Bearer token. */
  private bearer(header: string | undefined): string | null | 'malformed' {
    if (header === undefined) return null;
    const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header);
    if (!m || m[1]!.length > MAX_TOKEN_LENGTH) return 'malformed';
    return m[1]!;
  }

  /** Maps verification failures to a metric reason; infrastructure trouble becomes a 503. */
  private classify(e: unknown): null {
    if (e instanceof errors.JWTExpired) return this.reject('expired');
    if (e instanceof errors.JWTClaimValidationFailed) {
      return this.reject(e.claim === 'iss' ? 'invalid_issuer' : e.claim === 'aud' ? 'invalid_audience' : 'invalid_claims');
    }
    if (e instanceof errors.JOSEAlgNotAllowed) return this.reject('algorithm_not_allowed');
    if (e instanceof errors.JWSSignatureVerificationFailed) return this.reject('invalid_signature');
    if (e instanceof errors.JWKSNoMatchingKey) return this.reject('unknown_key');
    if (e instanceof errors.JWKSMultipleMatchingKeys) return this.reject('ambiguous_key');
    if (e instanceof errors.JWTInvalid || e instanceof errors.JWSInvalid) return this.reject('malformed_token');
    if (e instanceof errors.JOSEError && !(e instanceof errors.JWKSTimeout) && e.code !== 'ERR_JOSE_GENERIC') {
      return this.reject('invalid_token');
    }
    // Timeout, network failure or a non-200 answer from the JWKS endpoint: the IdP is unreachable, not the token wrong.
    this.metrics.inc('auth_failures_total', { reason: 'jwks_unavailable' });
    this.logger.warn({ event: 'auth_jwks_unavailable', error: (e as Error)?.message });
    throw new ServiceUnavailableException('identity provider unavailable');
  }

  private reject(reason: string): null {
    this.metrics.inc('auth_failures_total', { reason });
    this.logger.warn({ event: 'auth_rejected', reason });
    return null;
  }

  /** JWKS client, built lazily (and rebuilt after a failed discovery) so the API can start before the IdP does. */
  private keys(): Promise<Jwks> {
    this.jwks ??= this.buildJwks().catch((e: Error) => {
      this.jwks = undefined; // retry on the next request
      this.metrics.inc('auth_failures_total', { reason: 'jwks_unavailable' });
      this.logger.warn({ event: 'auth_discovery_failed', error: e.message });
      throw new ServiceUnavailableException('identity provider unavailable');
    });
    return this.jwks;
  }

  private async buildJwks(): Promise<Jwks> {
    let uri = this.config.jwksUri;
    if (!uri) {
      const url = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(this.config.jwksTimeoutMs) });
      if (!res.ok) throw new Error(`OIDC discovery answered ${res.status}`);
      const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
      // Guards against a discovery document that belongs to a different issuer (mix-up).
      if (doc.issuer !== this.config.issuer) throw new Error('OIDC discovery issuer does not match AUTH_ISSUER');
      if (!doc.jwks_uri) throw new Error('OIDC discovery has no jwks_uri');
      uri = doc.jwks_uri;
    }
    return createRemoteJWKSet(new URL(uri), {
      timeoutDuration: this.config.jwksTimeoutMs,
      cooldownDuration: this.config.jwksCooldownMs,
    });
  }
}

import { exportJWK, exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload } from 'jose';

interface KeyEntry {
  kid: string;
  alg: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JWK;
}

export interface TokenOptions {
  /** Extra / overriding claims (roles, provider_id, realm_access, ...). `sub` defaults to "user-1". */
  claims?: JWTPayload;
  kid?: string;
  alg?: string;
  issuer?: string;
  audience?: string | string[];
  /** Seconds from now (negative = already expired). Default 300. `null` omits `exp`. */
  expiresIn?: number | null;
  notBefore?: number;
  omitSub?: boolean;
  /** Sign with this key instead of the one registered under `kid` (to forge a token with a known `kid`). */
  signWith?: CryptoKey;
}

/**
 * A minimal OpenID Provider for tests: OIDC discovery + a JWKS endpoint backed by freshly generated keys, and a signer.
 * It speaks the same protocol Keycloak and Zitadel do, so the application's real validation path is what gets exercised.
 */
export class FakeIdp {
  private readonly keys = new Map<string, KeyEntry>();
  private server?: ReturnType<typeof Bun.serve>;
  port = 0;
  jwksRequests = 0;
  discoveryRequests = 0;
  /** When set, the discovery document claims this issuer (mix-up attack). */
  discoveryIssuerOverride: string | undefined;

  get issuer(): string {
    return `http://localhost:${this.port}`;
  }
  get jwksUri(): string {
    return `${this.issuer}/jwks`;
  }

  static async start(port = 0): Promise<FakeIdp> {
    const idp = new FakeIdp();
    await idp.addKey('key-1');
    idp.listen(port);
    return idp;
  }

  listen(port = this.port): void {
    this.server = Bun.serve({
      port,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/.well-known/openid-configuration') {
          this.discoveryRequests++;
          return Response.json({ issuer: this.discoveryIssuerOverride ?? this.issuer, jwks_uri: this.jwksUri });
        }
        if (path === '/jwks') {
          this.jwksRequests++;
          return Response.json({ keys: [...this.keys.values()].map((k) => k.jwk) });
        }
        return new Response('not found', { status: 404 });
      },
    });
    this.port = this.server.port!;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  async addKey(kid: string, alg = 'RS256'): Promise<KeyEntry> {
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
    const entry = { kid, alg, privateKey, publicKey, jwk };
    this.keys.set(kid, entry);
    return entry;
  }

  key(kid: string): KeyEntry {
    return this.keys.get(kid)!;
  }

  async sign(o: TokenOptions = {}): Promise<string> {
    const kid = o.kid ?? 'key-1';
    const entry = this.keys.get(kid);
    const alg = o.alg ?? entry?.alg ?? 'RS256';
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ ...(o.omitSub ? {} : { sub: 'user-1' }), ...o.claims })
      .setProtectedHeader({ alg, kid, typ: 'JWT' })
      .setIssuer(o.issuer ?? this.issuer)
      .setAudience(o.audience ?? 'wagering-api')
      .setIssuedAt(now);
    if (o.expiresIn !== null) jwt.setExpirationTime(now + (o.expiresIn ?? 300));
    if (o.notBefore !== undefined) jwt.setNotBefore(now + o.notBefore);
    return jwt.sign(o.signWith ?? entry!.privateKey);
  }

  /** The key a token would be forged with if an attacker used the public key as an HMAC secret. */
  async publicKeyPem(kid = 'key-1'): Promise<string> {
    return exportSPKI(this.keys.get(kid)!.publicKey);
  }
}

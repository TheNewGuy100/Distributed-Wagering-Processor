import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Authentication extension point. The service owns no user table: identity belongs to an external
 * identity provider (Keycloak / Zitadel). Plugging one in means providing another `Authenticator`
 * that validates the bearer token (JWKS signature, issuer, audience, expiry) and maps its claims
 * to a Principal — nothing else in the codebase needs to change.
 */
export interface Principal {
  subject: string;
  /** When set, the caller may only act for this provider (checked against the request's providerId). */
  providerId: string | null;
  roles: readonly string[];
}

export interface Authenticator {
  /** Returns the caller, or null when the request is not authenticated. Must not throw for bad tokens. */
  authenticate(req: Request): Promise<Principal | null>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

/** Default: authentication is disabled (documented in ARCHITECTURE.md); every caller is anonymous. */
@Injectable()
export class NoopAuthenticator implements Authenticator {
  async authenticate(): Promise<Principal | null> {
    return { subject: 'anonymous', providerId: null, roles: [] };
  }
}

export const IS_PUBLIC = 'isPublic';
/** Marks an endpoint that never requires authentication (health probes, metrics scrape). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = await this.authenticator.authenticate(req);
    if (!principal) throw new UnauthorizedException();
    req.principal = principal;
    return true;
  }
}

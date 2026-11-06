import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { LogContext } from '../../../infrastructure/observability/log-context';
import { MetricsService } from '../../../infrastructure/observability/metrics.service';

/**
 * Authentication and authorization. The service owns no user table: identity belongs to an external identity
 * provider (Keycloak / Zitadel). An `Authenticator` turns a request into a `Principal` (see `JwtAuthenticator`); the
 * guard below then enforces roles, and `ProviderAccessPolicy` enforces provider scoping inside the handlers.
 */
export interface Principal {
  subject: string;
  /** When set, the caller may only act for this provider. */
  providerId: string | null;
  roles: readonly string[];
}

export interface Authenticator {
  /**
   * Returns the caller, or null when the request is not authenticated (the guard answers 401). Must not throw for a
   * bad token; it may throw 503 when the identity provider cannot be reached.
   */
  authenticate(req: Request): Promise<Principal | null>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

/** Roles. `admin` implies every other role. */
export const Role = {
  Admin: 'admin',
  WagerSubmit: 'wager:submit',
  WagerRead: 'wager:read',
  WalletRead: 'wallet:read',
  WalletWrite: 'wallet:write',
  WalletReconcile: 'wallet:reconcile',
} as const;

/** Default (AUTH_MODE=none): authentication is disabled and every caller acts as an administrator. */
@Injectable()
export class NoopAuthenticator implements Authenticator {
  async authenticate(): Promise<Principal | null> {
    return { subject: 'anonymous', providerId: null, roles: [Role.Admin] };
  }
}

export const IS_PUBLIC = 'isPublic';
/** Marks an endpoint that never requires authentication (health probes, metrics scrape). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_ROLES = 'requiredRoles';
/** The caller needs at least one of these roles (or `admin`). Endpoints without it only require authentication. */
export const RequireRoles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES, roles);

/** The authenticated caller, as resolved by the guard. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest<{ principal: Principal }>().principal,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = await this.authenticator.authenticate(req);
    if (!principal) throw new UnauthorizedException();
    req.principal = principal;
    LogContext.set({ subject: principal.subject });

    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_ROLES, targets);
    if (required && required.length > 0 && !principal.roles.includes(Role.Admin) && !required.some((r) => principal.roles.includes(r))) {
      this.metrics.inc('auth_failures_total', { reason: 'forbidden_role' });
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}

/** Provider scoping: a token carrying a provider may only act for that provider. */
@Injectable()
export class ProviderAccessPolicy {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  allows(principal: Principal, providerId: string): boolean {
    return principal.providerId === null || principal.providerId === providerId;
  }

  /** Throws 403 when the principal is scoped to another provider. */
  assert(principal: Principal, providerId: string): void {
    if (this.allows(principal, providerId)) return;
    this.metrics.inc('auth_failures_total', { reason: 'forbidden_provider' });
    throw new ForbiddenException('token is scoped to another provider');
  }
}

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TokenService } from '../token.service';
import { SessionsService } from '../sessions/sessions.service';
import { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Global authentication guard. Verifies the Bearer access token and confirms the backing session
 * is still active (not revoked/expired) — this is what makes logout and admin session-revocation
 * effective despite stateless JWTs. Routes marked {@link Public} are allowed through. The
 * authenticated principal is attached to `request.user`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractBearer(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    const session = await this.sessions.findActive(claims.sid);
    if (!session) {
      throw new UnauthorizedException('Session is no longer active.');
    }
    void this.sessions.touch(claims.sid);

    request.user = {
      userId: claims.sub,
      email: claims.email,
      roles: claims.roles,
      sessionId: claims.sid,
    };
    return true;
  }

  private extractBearer(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}

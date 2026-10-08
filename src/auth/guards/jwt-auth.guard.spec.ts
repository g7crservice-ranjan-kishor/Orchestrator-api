import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from '../token.service';
import { SessionsService } from '../sessions/sessions.service';

function context(
  headers: Record<string, string>,
  req: Record<string, unknown> = {},
): ExecutionContext {
  const request = { headers, ...req };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const make = (opts: {
    isPublic?: boolean;
    claims?: unknown;
    verifyThrows?: boolean;
    sessionActive?: boolean;
  }): JwtAuthGuard => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(opts.isPublic ?? false),
    } as unknown as Reflector;
    const tokens = {
      verifyAccessToken: opts.verifyThrows
        ? jest.fn().mockRejectedValue(new Error('bad'))
        : jest
            .fn()
            .mockResolvedValue(opts.claims ?? { sub: 'u1', email: 'e', roles: [], sid: 's1' }),
    } as unknown as TokenService;
    const sessions = {
      findActive: jest.fn().mockResolvedValue(opts.sessionActive ? { id: 's1' } : null),
      touch: jest.fn().mockResolvedValue(undefined),
    } as unknown as SessionsService;
    return new JwtAuthGuard(reflector, tokens, sessions);
  };

  it('allows public routes without a token', async () => {
    const guard = make({ isPublic: true });
    await expect(guard.canActivate(context({}))).resolves.toBe(true);
  });

  it('rejects when the bearer token is missing', async () => {
    const guard = make({});
    await expect(guard.canActivate(context({}))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid token', async () => {
    const guard = make({ verifyThrows: true });
    await expect(guard.canActivate(context({ authorization: 'Bearer bad' }))).rejects.toThrow(
      'Invalid or expired token.',
    );
  });

  it('rejects when the backing session is not active (revoked/expired)', async () => {
    const guard = make({ sessionActive: false });
    await expect(guard.canActivate(context({ authorization: 'Bearer good' }))).rejects.toThrow(
      'Session is no longer active.',
    );
  });

  it('attaches the user and allows an active session', async () => {
    const guard = make({ sessionActive: true });
    const req: Record<string, unknown> = {};
    const ctx = context({ authorization: 'Bearer good' }, req);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

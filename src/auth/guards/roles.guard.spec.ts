import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role } from '../../users/schemas/user.schema';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const makeGuard = (required: Role[] | undefined): RolesGuard => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(required),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  };

  it('allows any authenticated user when no roles are required', () => {
    const guard = makeGuard(undefined);
    expect(guard.canActivate(contextWithUser({ roles: [] }))).toBe(true);
  });

  it('allows a user holding the required role', () => {
    const guard = makeGuard([Role.Administrator]);
    expect(guard.canActivate(contextWithUser({ roles: [Role.Administrator] }))).toBe(true);
  });

  it('denies a user missing the required role', () => {
    const guard = makeGuard([Role.Administrator]);
    expect(() => guard.canActivate(contextWithUser({ roles: [] }))).toThrow(ForbiddenException);
  });

  it('denies when there is no authenticated user', () => {
    const guard = makeGuard([Role.Administrator]);
    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});

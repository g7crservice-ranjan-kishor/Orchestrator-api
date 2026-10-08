import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role } from '../../users/schemas/user.schema';
import { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Enforces role requirements declared with {@link Roles}. Runs after {@link JwtAuthGuard}, so
 * `request.user` is populated. Routes without a `@Roles` requirement are allowed for any
 * authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user || !user.roles?.some((role) => required.includes(role))) {
      throw new ForbiddenException('Insufficient role.');
    }
    return true;
  }
}

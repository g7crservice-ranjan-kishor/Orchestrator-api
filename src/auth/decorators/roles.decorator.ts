import { SetMetadata } from '@nestjs/common';
import { Role } from '../../users/schemas/user.schema';

/** Metadata key carrying the roles required to access a route. */
export const ROLES_KEY = 'roles';

/**
 * Restricts a route/controller to users holding at least one of the given roles. Enforced by
 * {@link RolesGuard}. Phase 1 uses this for Administrator-only endpoints.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

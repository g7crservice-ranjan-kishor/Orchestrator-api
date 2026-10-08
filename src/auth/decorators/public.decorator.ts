import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as publicly accessible (skips the global JWT auth guard). */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route handler or controller as public so the global {@link JwtAuthGuard} lets it
 * through without a valid session (e.g. `/health`, `/auth/login`).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

import { Role } from '../../users/schemas/user.schema';

/** The authenticated principal attached to a request after the JWT guard runs. */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: Role[];
  sessionId: string;
}

/** Claims embedded in the access-token JWT. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  roles: Role[];
  sid: string;
}

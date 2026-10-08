import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../common/config/app-config.service';
import { AccessTokenClaims } from './types/authenticated-user';
import { UserDocument } from '../users/schemas/user.schema';
import { SessionDocument } from './sessions/schemas/session.schema';

/**
 * Issues and verifies short-lived access-token JWTs. The signing key is injected asynchronously
 * from Key Vault via {@link JwtModule} configuration; this service only encodes/decodes the typed
 * {@link AccessTokenClaims}. Refresh/rotation is handled by the session store, not the JWT.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /** Signs an access token binding the user to a specific session id. */
  async issueAccessToken(user: UserDocument, session: SessionDocument): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      sid: session.id,
    };
    return this.jwt.signAsync(claims, { expiresIn: this.config.jwtAccessTtlSeconds });
  }

  /** Verifies and decodes an access token, or throws if invalid/expired. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token);
  }

  get accessTokenTtlSeconds(): number {
    return this.config.jwtAccessTtlSeconds;
  }
}

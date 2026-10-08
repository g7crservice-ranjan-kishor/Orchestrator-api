import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { UsersService } from '../users/users.service';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserDocument } from '../users/schemas/user.schema';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { SessionContext, SessionsService } from './sessions/sessions.service';
import { SessionDocument } from './sessions/schemas/session.schema';
import { AuthResponseDto } from './dto/auth-response.dto';

/** Lockout policy (login hardening lands fully in Sprint 2; the guard rails exist here). */
const MAX_FAILED_ATTEMPTS = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Native authentication: credential validation (argon2id), session creation, access-token
 * issuance, refresh-token rotation, and logout. Login is intentionally vague about *why* it failed
 * (invalid credentials vs disabled vs locked map to the same client-facing message where it would
 * leak account state) to avoid user enumeration.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    private readonly config: AppConfigService,
  ) {}

  /** Validates credentials and returns the user, or null if authentication fails. */
  private async validateCredentials(email: string, password: string): Promise<UserDocument | null> {
    const user = await this.users.findByEmail(email);
    if (!user || user.disabled) {
      return null;
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return null;
    }
    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      await this.users.registerFailedLogin(user.id, MAX_FAILED_ATTEMPTS, LOCK_DURATION_MS);
      return null;
    }
    await this.users.registerSuccessfulLogin(user.id);
    return user;
  }

  async login(email: string, password: string, ctx: SessionContext): Promise<AuthResponseDto> {
    const user = await this.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    const { session, refreshToken } = await this.sessions.create(
      user.id,
      this.config.sessionTtlSeconds * 1000,
      ctx,
    );
    return this.buildResult(user, session, refreshToken);
  }

  async refresh(sessionId: string, refreshToken: string): Promise<AuthResponseDto> {
    const rotated = await this.sessions.validateAndRotate(
      sessionId,
      refreshToken,
      this.config.sessionTtlSeconds * 1000,
    );
    if (!rotated) {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    const user = await this.users.findById(rotated.session.userId.toString());
    if (user.disabled) {
      await this.sessions.revoke(sessionId);
      throw new UnauthorizedException('Account is disabled.');
    }
    return this.buildResult(user, rotated.session, rotated.refreshToken);
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  private async buildResult(
    user: UserDocument,
    session: SessionDocument,
    refreshToken: string,
  ): Promise<AuthResponseDto> {
    const accessToken = await this.tokens.issueAccessToken(user, session);
    return {
      accessToken,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      sessionId: session.id,
      refreshToken,
      user: UserResponseDto.fromDocument(user),
    };
  }
}

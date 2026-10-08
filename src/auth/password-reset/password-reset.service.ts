import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { PasswordService } from '../password.service';
import { UsersService } from '../../users/users.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  PasswordResetToken,
  PasswordResetTokenDocument,
} from './schemas/password-reset-token.schema';

/** Token lifetime: 30 minutes. */
const RESET_TTL_MS = 30 * 60 * 1000;

/**
 * One-time password-reset flow. `request` is enumeration-safe (always succeeds); `confirm`
 * validates a single-use, expiring token, sets the new password, and revokes all of the user's
 * sessions so any attacker session is invalidated. Token secrets are stored only as argon2id
 * hashes and never logged.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @InjectModel(PasswordResetToken.name)
    private readonly model: Model<PasswordResetTokenDocument>,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
  ) {}

  /** Issues a reset token for the email if it exists; returns the raw token (caller decides delivery). */
  async request(email: string, nowMs = Date.now()): Promise<string | null> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      return null; // enumeration-safe: caller returns the same message regardless
    }
    const tokenId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    await new this.model({
      userId: user._id,
      tokenId,
      secretHash: await this.passwords.hash(secret),
      expiresAt: new Date(nowMs + RESET_TTL_MS),
    }).save();
    return `${tokenId}.${secret}`;
  }

  /** Validates and consumes a reset token, sets the new password, and revokes existing sessions. */
  async confirm(token: string, newPassword: string, nowMs = Date.now()): Promise<void> {
    const [tokenId, secret] = token.split('.');
    if (!tokenId || !secret) {
      throw new BadRequestException('Invalid or expired reset token.');
    }
    const record = await this.model.findOne({ tokenId }).exec();
    if (
      !record ||
      record.usedAt ||
      record.expiresAt.getTime() <= nowMs ||
      !(await this.passwords.verify(record.secretHash, secret))
    ) {
      throw new BadRequestException('Invalid or expired reset token.');
    }
    record.usedAt = new Date(nowMs);
    await record.save();

    await this.users.update(record.userId.toString(), { password: newPassword });

    // Invalidate all existing sessions for the user after a password change.
    const sessions = await this.sessions.listForUser(record.userId.toString());
    await Promise.all(sessions.filter((s) => !s.revoked).map((s) => this.sessions.revoke(s.id)));
    this.logger.log(`Password reset completed for user ${record.userId.toString()}`);
  }
}

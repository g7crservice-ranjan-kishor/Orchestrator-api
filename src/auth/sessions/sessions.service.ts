import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { PasswordService } from '../password.service';
import { Session, SessionDocument } from './schemas/session.schema';

/** Result of creating or rotating a session: the persisted doc + the raw refresh token (once). */
export interface IssuedSession {
  session: SessionDocument;
  refreshToken: string;
}

/** Client context captured on a session. */
export interface SessionContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

/**
 * Server-side session store backing refresh tokens. The raw refresh token is generated here,
 * returned to the caller exactly once, and persisted only as an argon2id hash. Sessions can be
 * validated (with rotation) and revoked.
 */
@Injectable()
export class SessionsService {
  constructor(
    @InjectModel(Session.name) private readonly sessionModel: Model<SessionDocument>,
    private readonly passwords: PasswordService,
  ) {}

  private generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /** Creates a new session for a user and returns the raw refresh token once. */
  async create(userId: string, ttlMs: number, ctx: SessionContext = {}): Promise<IssuedSession> {
    const refreshToken = this.generateRefreshToken();
    const refreshTokenHash = await this.passwords.hash(refreshToken);
    const session = await new this.sessionModel({
      userId: new Types.ObjectId(userId),
      refreshTokenHash,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ipAddress ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
      lastSeenAt: new Date(),
    }).save();
    return { session, refreshToken };
  }

  /** Returns the session if active (exists, not revoked, not expired); otherwise null. */
  async findActive(sessionId: string): Promise<SessionDocument | null> {
    if (!Types.ObjectId.isValid(sessionId)) {
      return null;
    }
    const session = await this.sessionModel.findById(sessionId).exec();
    if (!session || session.revoked || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return session;
  }

  /**
   * Validates a refresh token against its session and rotates it (issues a fresh refresh token,
   * extends the window). Returns the new raw refresh token, or null if invalid/expired/revoked.
   */
  async validateAndRotate(
    sessionId: string,
    refreshToken: string,
    ttlMs: number,
  ): Promise<IssuedSession | null> {
    const session = await this.findActive(sessionId);
    if (!session) {
      return null;
    }
    const matches = await this.passwords.verify(session.refreshTokenHash, refreshToken);
    if (!matches) {
      return null;
    }
    const newToken = this.generateRefreshToken();
    session.refreshTokenHash = await this.passwords.hash(newToken);
    session.expiresAt = new Date(Date.now() + ttlMs);
    session.lastSeenAt = new Date();
    await session.save();
    return { session, refreshToken: newToken };
  }

  /** Updates the last-seen timestamp (best-effort; used on authenticated requests). */
  async touch(sessionId: string): Promise<void> {
    await this.sessionModel
      .updateOne({ _id: sessionId }, { $set: { lastSeenAt: new Date() } })
      .exec();
  }

  /** Revokes a single session (idempotent). */
  async revoke(sessionId: string): Promise<void> {
    await this.sessionModel
      .updateOne({ _id: sessionId }, { $set: { revoked: true, revokedAt: new Date() } })
      .exec();
  }

  /** Lists a user's sessions, newest first. */
  listForUser(userId: string): Promise<SessionDocument[]> {
    return this.sessionModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .exec();
  }
}

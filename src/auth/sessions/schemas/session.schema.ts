import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SessionDocument = HydratedDocument<Session>;

/**
 * A server-side session backing a refresh token (native auth — engagement decision). The refresh
 * token is stored only as an argon2id hash; the raw token is returned to the client once at login.
 * Sessions capture device/IP and timestamps and can be revoked (logout or admin action), which
 * immediately invalidates the associated access tokens on their next request.
 */
@Schema({ collection: 'sessions', timestamps: true })
export class Session {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  /** argon2id hash of the current (rotating) refresh token. */
  @Prop({ required: true })
  refreshTokenHash!: string;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ipAddress!: string | null;

  @Prop({ type: Date, required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: () => new Date() })
  lastSeenAt!: Date;

  @Prop({ default: false })
  revoked!: boolean;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

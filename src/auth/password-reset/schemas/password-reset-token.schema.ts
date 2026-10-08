import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PasswordResetTokenDocument = HydratedDocument<PasswordResetToken>;

/**
 * A single-use password-reset token. The token presented to the user is `tokenId.secret`; only the
 * argon2id hash of `secret` is stored, and `tokenId` is the lookup selector. Tokens expire and are
 * consumed exactly once (`usedAt`).
 */
@Schema({ collection: 'passwordResetTokens', timestamps: true })
export class PasswordResetToken {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, unique: true, index: true })
  tokenId!: string;

  @Prop({ required: true })
  secretHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  usedAt!: Date | null;
}

export const PasswordResetTokenSchema = SchemaFactory.createForClass(PasswordResetToken);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Application roles. Phase 1 ships a single Administrator role but the model is role-aware so
 * more roles can be added without rework (PROJECT_OVERVIEW.md §3).
 */
export enum Role {
  Administrator = 'administrator',
}

export type UserDocument = HydratedDocument<User>;

/**
 * A platform user. The password is stored only as an argon2id hash — never in plaintext
 * (ENVIRONMENT_CONFIGURATION.md §4). `email` is unique and used as the login identifier.
 */
@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ required: true })
  displayName!: string;

  /** argon2id hash of the password. Never serialised to API responses. */
  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ type: [String], enum: Role, default: [Role.Administrator] })
  roles!: Role[];

  @Prop({ default: false })
  disabled!: boolean;

  /** Consecutive failed login attempts, used for lockout (auth hardening, Sprint 2). */
  @Prop({ default: 0 })
  failedLoginAttempts!: number;

  /** When set and in the future, the account is temporarily locked. */
  @Prop({ type: Date, default: null })
  lockedUntil!: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

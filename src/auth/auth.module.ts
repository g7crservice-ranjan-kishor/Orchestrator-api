import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../common/config/app-config.module';
import { AppConfigService } from '../common/config/app-config.service';
import { SecretsModule } from '../common/secrets/secrets.module';
import { SecretsService } from '../common/secrets/secrets.service';
import { UsersModule } from '../users/users.module';
import { PasswordModule } from './password.module';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Session, SessionSchema } from './sessions/schemas/session.schema';
import { SessionsService } from './sessions/sessions.service';
import { PasswordResetService } from './password-reset/password-reset.service';
import {
  PasswordResetToken,
  PasswordResetTokenSchema,
} from './password-reset/schemas/password-reset-token.schema';

/**
 * Native authentication module: argon2id passwords, JWT access tokens (signing key from Key
 * Vault), server-side refresh sessions, and RBAC. Registers {@link JwtAuthGuard} as a global guard
 * so every route requires a valid session unless marked `@Public`.
 */
@Module({
  imports: [
    UsersModule,
    PasswordModule,
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: PasswordResetToken.name, schema: PasswordResetTokenSchema },
    ]),
    JwtModule.registerAsync({
      imports: [AppConfigModule, SecretsModule],
      inject: [AppConfigService, SecretsService],
      useFactory: async (config: AppConfigService, secrets: SecretsService) => ({
        secret: await secrets.require('JWT_SIGNING_KEY'),
        signOptions: { expiresIn: config.jwtAccessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    SessionsService,
    PasswordResetService,
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [SessionsService, TokenService],
})
export class AuthModule {}

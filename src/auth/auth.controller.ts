import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthenticatedUser } from './types/authenticated-user';
import { UsersService } from '../users/users.service';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { AppConfigService } from '../common/config/app-config.service';
import { PasswordResetService } from './password-reset/password-reset.service';
import {
  ConfirmPasswordResetDto,
  RequestPasswordResetDto,
  RequestPasswordResetResponseDto,
} from './password-reset/dto/password-reset.dto';

/** Tighter rate limit for sensitive auth endpoints: 5 requests / 60s per IP. */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly passwordReset: PasswordResetService,
    private readonly config: AppConfigService,
  ) {}

  private clientContext(req: Request): { userAgent: string | null; ipAddress: string | null } {
    return {
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      ipAddress: req.ip ?? null,
    };
  }

  @Post('login')
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email + password; returns tokens and session.' })
  @ApiOkResponse({ type: AuthResponseDto })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthResponseDto> {
    return this.auth.login(dto.email, dto.password, this.clientContext(req));
  }

  @Post('refresh')
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new access token (rotates the token).' })
  @ApiOkResponse({ type: AuthResponseDto })
  refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
    return this.auth.refresh(dto.sessionId, dto.refreshToken);
  }

  @Post('password-reset/request')
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request a one-time password-reset token (enumeration-safe).' })
  @ApiOkResponse({ type: RequestPasswordResetResponseDto })
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
  ): Promise<RequestPasswordResetResponseDto> {
    const token = await this.passwordReset.request(dto.email);
    const response: RequestPasswordResetResponseDto = {
      message: 'If the account exists, a reset token has been issued.',
    };
    // Convenience for local/dev only — never expose the token in production.
    if (token && !this.config.isProduction) {
      response.devToken = token;
    }
    return response;
  }

  @Post('password-reset/confirm')
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm a password reset with a one-time token and new password.' })
  async confirmPasswordReset(@Body() dto: ConfirmPasswordResetDto): Promise<void> {
    await this.passwordReset.confirm(dto.token, dto.newPassword);
  }

  @Post('logout')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session.' })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.auth.logout(user.sessionId);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Return the currently authenticated user.' })
  @ApiOkResponse({ type: UserResponseDto })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    const doc = await this.users.findById(user.userId);
    return UserResponseDto.fromDocument(doc);
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

/** Request a password-reset token for an email. */
export class RequestPasswordResetDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail()
  email!: string;
}

/** Confirm a password reset with a one-time token and a new password. */
export class ConfirmPasswordResetDto {
  @ApiProperty({ description: 'One-time reset token (tokenId.secret).' })
  @IsString()
  @MinLength(1)
  token!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  newPassword!: string;
}

/** Response to a reset request. `devToken` is only populated outside production. */
export class RequestPasswordResetResponseDto {
  @ApiProperty({ example: 'If the account exists, a reset token has been issued.' })
  message!: string;

  @ApiProperty({
    required: false,
    description: 'Dev-only: the reset token (never set in production).',
  })
  devToken?: string;
}

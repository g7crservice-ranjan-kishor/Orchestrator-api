import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Refresh-token exchange payload. */
export class RefreshDto {
  @ApiProperty({ description: 'Session id issued at login.' })
  @IsString()
  @MinLength(1)
  sessionId!: string;

  @ApiProperty({ description: 'Raw refresh token issued at login (or last refresh).' })
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

/** Successful authentication result returned by login/refresh. */
export class AuthResponseDto {
  @ApiProperty({ description: 'Short-lived JWT access token.' })
  accessToken!: string;

  @ApiProperty({ description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty({ description: 'Server-side session id (pair with the refresh token).' })
  sessionId!: string;

  @ApiProperty({ description: 'Raw refresh token — store securely; shown once per issue.' })
  refreshToken!: string;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}

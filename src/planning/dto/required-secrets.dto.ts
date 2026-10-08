import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';

/** One credential the generated application needs, as declared by the planning agent. */
export class RequiredSecretDto {
  @ApiProperty({ description: 'Environment variable the application reads, e.g. DATABASE_URL.' })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, {
    message: 'name must be an environment variable name (letters, digits, underscore)',
  })
  name!: string;

  @ApiProperty({ required: false, description: 'What it is and where to obtain it.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ required: false, description: 'A non-secret example of the expected shape.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  example?: string;
}

/** The EM run declares every credential the application will need at runtime — names, never values. */
export class DeclareRequiredSecretsDto {
  @ApiProperty({ type: [RequiredSecretDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RequiredSecretDto)
  secrets!: RequiredSecretDto[];
}

/** A human supplies one credential's value. Write-only — no endpoint ever returns it. */
export class SetRequiredSecretDto {
  @ApiProperty({
    description: 'The secret value. Stored in Key Vault; never persisted in MongoDB.',
  })
  @IsString()
  @MaxLength(8192)
  value!: string;
}

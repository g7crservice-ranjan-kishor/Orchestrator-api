import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Role } from '../schemas/user.schema';

/** Partial update for a user (Administrator-only). Password changes are optional. */
export class UpdateUserDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  displayName?: string;

  @ApiProperty({ required: false, minLength: 12 })
  @IsOptional()
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  password?: string;

  @ApiProperty({ enum: Role, isArray: true, required: false })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(Role, { each: true })
  roles?: Role[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

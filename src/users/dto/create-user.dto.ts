import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Role } from '../schemas/user.schema';

/** Payload for creating a user (Administrator-only). */
export class CreateUserDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Platform Admin' })
  @IsString()
  @MinLength(1)
  displayName!: string;

  @ApiProperty({ example: 'a-strong-password', minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  password!: string;

  @ApiProperty({ enum: Role, isArray: true, required: false, default: [Role.Administrator] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(Role, { each: true })
  roles?: Role[];
}

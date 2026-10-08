import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Text requirement intake payload. */
export class CreateRequirementDto {
  @ApiProperty({ example: 'Build a customer feedback portal with ...', minLength: 10 })
  @IsString()
  @MinLength(10, { message: 'requirement text must be at least 10 characters' })
  text!: string;
}

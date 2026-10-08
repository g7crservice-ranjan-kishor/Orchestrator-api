import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** An answer a person gives for one technical decision the requirement left open. */
export class SetTechnicalDetailDto {
  @ApiProperty({ example: 'React', description: 'The value to record for this detail.' })
  @IsString()
  @MinLength(1, { message: 'Give a value for this technical detail.' })
  @MaxLength(200)
  value!: string;
}

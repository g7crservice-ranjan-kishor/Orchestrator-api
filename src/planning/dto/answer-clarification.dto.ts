import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Admin's answer to an EM clarification question. */
export class AnswerClarificationDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  answer!: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional "request changes" feedback the EM uses to revise the plan on regeneration. */
export class RegeneratePlanDto {
  @ApiPropertyOptional({ description: 'What to change in the plan.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}

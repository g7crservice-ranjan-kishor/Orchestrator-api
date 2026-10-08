import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Request to close the active sprint and start the next one (Development board). */
export class CompleteSprintDto {
  @ApiProperty({
    required: false,
    description:
      'Validate only: returns the dates that would be written, the Tasks that would carry over, and any blockers — without changing Azure DevOps. Backs the confirmation dialog.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

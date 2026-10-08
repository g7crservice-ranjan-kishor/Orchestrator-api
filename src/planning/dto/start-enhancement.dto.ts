import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * A new planning cycle on a product that has already been built.
 *
 * The requirement text itself goes in as an ordinary requirement first — enhancements are planned
 * from the same intake the initial build used, so the EM agent reads them the same way and nothing
 * needs a second path for "requirement, but for a change".
 */
export class StartEnhancementDto {
  @ApiProperty({
    example: 'Implement Dark Mode',
    description: 'What this enhancement is called. Shown beside its ENH number.',
  })
  @IsString()
  @MinLength(3, { message: 'Give the enhancement a title of at least 3 characters.' })
  @MaxLength(120)
  title!: string;

  @ApiProperty({
    required: false,
    description: 'The requirement to plan against. Defaults to the most recently submitted one.',
  })
  @IsOptional()
  @IsString()
  requirementId?: string;

  @ApiProperty({
    required: false,
    enum: ['current', 'next'],
    default: 'current',
    description:
      'Where the enhancement’s first sprint lands. `current` starts the work now; `next` keeps a ' +
      'sprint already in flight undisturbed.',
  })
  @IsOptional()
  @IsIn(['current', 'next'])
  sprintAnchor?: 'current' | 'next';
}

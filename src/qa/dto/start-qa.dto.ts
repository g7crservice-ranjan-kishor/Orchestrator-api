import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

/** Request to start a QA wave for every Ready-for-QA item in the project. */
export class StartQaDto {
  @ApiProperty({
    required: false,
    description:
      'Validate only: reports exactly which Stories/Bugs would get a QA pod and why the rest are skipped, without dispatching anything. Backs the confirmation dialog.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Limit the wave to these work items (the per-Story "Start Testing" button). Omit to test everything that is ready.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  workItemIds?: string[];
}

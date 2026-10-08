import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

/** Azure DevOps target capture (org/project/area path). */
export class AdoTargetDto {
  @ApiProperty({ example: 'https://dev.azure.com/your-org' })
  @IsString()
  @Matches(/^https?:\/\/.+/, { message: 'orgUrl must be a valid URL' })
  orgUrl!: string;

  @ApiProperty({ example: 'NQAI-DevAutomation' })
  @IsString()
  @MinLength(1)
  project!: string;

  @ApiProperty({ example: 'NQAI-DevAutomation\\Agentic SDLC Orchestrator' })
  @IsString()
  @MinLength(1)
  areaPath!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * The ADO target the admin explicitly re-confirms before any write. Must be provided at
 * confirmation time (not silently taken from the project) so the confirmation is a deliberate act
 * recorded in the audit log.
 */
export class ConfirmAdoTargetDto {
  @ApiProperty({ example: 'https://dev.azure.com/g7crtipl' })
  @IsString()
  @MinLength(1)
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

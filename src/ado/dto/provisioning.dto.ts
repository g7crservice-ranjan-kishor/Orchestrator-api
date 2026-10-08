import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { DATABASE_IDS, DatabaseChoice } from '../../projects/database-choice';
import { UI_STYLE_IDS, UiStyleChoice } from '../../projects/ui-style-choice';

/** Credentials to check before a project is created from them. */
export class PreflightDto {
  @ApiProperty({ example: 'https://dev.azure.com/org' })
  @IsString()
  @MinLength(1)
  orgUrl!: string;

  /** Never stored by this call, never logged, never echoed back. */
  @ApiProperty({ description: 'Used for this check only; not stored by this endpoint.' })
  @IsString()
  @MinLength(1)
  pat!: string;

  /** When given, the reply also lists that project's area paths and repositories. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  project?: string;
}

/** Repositories the product needs, by name. Created in Azure DevOps if they do not exist. */
export class EnsureRepositoriesDto {
  @ApiProperty({ type: [String], example: ['expense-tracker-api', 'expense-tracker-ui'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  names!: string[];
}

/** The answers to what the plan said still had to be decided. */
export class ApplyConfigurationDto {
  @ApiProperty({ required: false, enum: DATABASE_IDS })
  @IsOptional()
  @IsIn(DATABASE_IDS)
  database?: DatabaseChoice;

  /** Repository names, not URLs — the orchestrator creates them and records what ADO reports. */
  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  repositories?: string[];

  /** The interface framework, so a requirement that asked for one actually gets it. */
  @ApiProperty({ required: false, enum: UI_STYLE_IDS })
  @IsOptional()
  @IsIn(UI_STYLE_IDS)
  uiStyle?: UiStyleChoice;
}

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsBoolean,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AdoTargetDto } from './ado-target.dto';
import { DATABASE_IDS, DEFAULT_DATABASE, DatabaseChoice } from '../database-choice';
import { DEFAULT_UI_STYLE, UI_STYLE_IDS, UiStyleChoice } from '../ui-style-choice';

/** Payload to create a project with its ADO target and selectable target repos. */
export class CreateProjectDto {
  @ApiProperty({ example: 'Agentic SDLC Orchestrator' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ required: false, default: '' })
  @IsOptional()
  @IsString()
  description?: string;

  /**
   * This project's own Azure DevOps token. Stored in Key Vault and never returned by any endpoint.
   * Optional: without one the project uses the platform token, as every project did before.
   */
  @ApiProperty({ required: false, description: 'Stored in Key Vault; never returned.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  adoPat?: string;

  /**
   * Create the Azure DevOps project named in `adoTarget`, instead of expecting it to exist.
   *
   * One Azure DevOps project per product. Area paths separate work items, but iterations do not
   * follow them — products sharing a project share one sprint timeline, so a second product
   * inherits the first one's active sprint. A project of its own makes the sprints its own.
   */
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  createAdoProject?: boolean;

  @ApiProperty({ type: AdoTargetDto })
  @ValidateNested()
  @Type(() => AdoTargetDto)
  adoTarget!: AdoTargetDto;

  @ApiProperty({ type: [String], required: false, example: ['NQAI-DevAutomation'] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  targetRepos?: string[];

  @ApiProperty({ required: false, enum: DATABASE_IDS, default: DEFAULT_DATABASE })
  @IsOptional()
  @IsIn(DATABASE_IDS)
  database?: DatabaseChoice;

  @ApiProperty({ required: false, enum: UI_STYLE_IDS, default: DEFAULT_UI_STYLE })
  @IsOptional()
  @IsIn(UI_STYLE_IDS)
  uiStyle?: UiStyleChoice;
}

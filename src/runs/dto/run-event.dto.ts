import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

/** Event types the Agent Runner streams (api/runs-events.md). */
export enum RunEventType {
  Running = 'running',
  Heartbeat = 'heartbeat',
  Log = 'log',
  Tool = 'tool',
  Ado = 'ado',
  Result = 'result',
}

/** Terminal run status carried by a `result` event. */
export enum RunResultStatus {
  Completed = 'Completed',
  Failed = 'Failed',
  Blocked = 'Blocked',
}

/**
 * A single streamed run event. One DTO covers all event types (discriminated by `type`); fields
 * required only for specific types are validated with `@ValidateIf` so the contract is enforced
 * per the streaming spec while keeping a single ingest endpoint.
 */
export class RunEventDto {
  @ApiProperty({ enum: RunEventType })
  @IsEnum(RunEventType)
  type!: RunEventType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  at?: string;

  // --- log ---
  @ApiProperty({ required: false })
  @ValidateIf((o: RunEventDto) => o.type === RunEventType.Log)
  @IsString()
  message?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  level?: string;

  // --- tool ---
  @ApiProperty({ required: false })
  @ValidateIf((o: RunEventDto) => o.type === RunEventType.Tool)
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  target?: string;

  // --- ado ---
  @ApiProperty({ required: false })
  @ValidateIf((o: RunEventDto) => o.type === RunEventType.Ado)
  @IsInt()
  workItem?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  to?: string;

  // --- result ---
  @ApiProperty({ required: false, enum: RunResultStatus })
  @ValidateIf((o: RunEventDto) => o.type === RunEventType.Result)
  @IsEnum(RunResultStatus)
  status?: RunResultStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  tokens?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  filesChanged?: number;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  commits?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  adoChanges?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  artifacts?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  workspacePath?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  logsRef?: string;

  /** Tail of the agent's final message, kept so a run that produced nothing can be read. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  output?: string;

  /** Build stamp of the worker image the pod ran, so a stale image is visible in the run. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  workerBuild?: string;
}

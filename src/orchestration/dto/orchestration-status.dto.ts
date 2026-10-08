import { ApiProperty } from '@nestjs/swagger';

/** A single dispatch wave's tallies (for the status surface). */
export class OrchestrationWaveDto {
  @ApiProperty() dispatched!: number;
  @ApiProperty() skippedActive!: number;
  @ApiProperty() deferred!: number;
}

/** Observable state of the orchestration scheduler (Phase 2.1). */
export class OrchestrationStatusDto {
  @ApiProperty({ description: 'Master on/off (pause/stop) switch state.' })
  enabled!: boolean;

  @ApiProperty({ description: 'Scheduler tick interval (ms).' })
  intervalMs!: number;

  @ApiProperty({ type: [String], description: 'Legs the loop drives (e.g. developer, qa).' })
  roles!: string[];

  @ApiProperty({ description: 'Global concurrency cap on dispatched pods.' })
  maxConcurrentRuns!: number;

  @ApiProperty({ description: 'Active (non-terminal) runs right now.' })
  activeRuns!: number;

  @ApiProperty({ description: 'Whether the QA leg has a bound dispatcher (Phase 3).' })
  qaLegAvailable!: boolean;

  @ApiProperty({ nullable: true, format: 'date-time', description: 'Timestamp of the last tick.' })
  lastTickAt!: string | null;

  @ApiProperty({ nullable: true, type: OrchestrationWaveDto, description: "Last tick's tallies." })
  lastWave!: OrchestrationWaveDto | null;
}

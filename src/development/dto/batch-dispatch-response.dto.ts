import { ApiProperty } from '@nestjs/swagger';
import { BatchDispatchResult } from '../development.service';

/** Summary of a batch dispatch wave for the API response (one pod fanned out per eligible Task). */
export class BatchDispatchResponseDto {
  @ApiProperty({ description: 'Total To Do Task candidates enumerated in the project area path.' })
  candidates!: number;

  @ApiProperty({ type: [String], description: 'Run ids dispatched this wave (one per Task).' })
  dispatchedRunIds!: string[];

  @ApiProperty({ description: 'Number of pods dispatched this wave.' })
  dispatchedCount!: number;

  @ApiProperty({
    type: [String],
    description: 'Tasks skipped — a run is already active (idempotent).',
  })
  skippedActive!: string[];

  @ApiProperty({
    type: [String],
    description: 'Eligible Tasks deferred to a later wave (over the cap).',
  })
  deferred!: string[];

  @ApiProperty({
    description: 'Tasks not dispatched with the reason (not To Do, parent not approved, …).',
  })
  ineligible!: { workItemId: string; reason: string }[];

  static fromResult(result: BatchDispatchResult): BatchDispatchResponseDto {
    return {
      candidates: result.candidates,
      dispatchedRunIds: result.dispatched.map((j) => j.runId),
      dispatchedCount: result.dispatched.length,
      skippedActive: result.skippedActive,
      deferred: result.deferred,
      ineligible: result.ineligible,
    };
  }
}

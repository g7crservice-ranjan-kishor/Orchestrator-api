import { ApiProperty } from '@nestjs/swagger';
import { QaDispatch } from '../../orchestration/qa-batch.seam';
import { QaBatchResult } from '../qa.service';

/** One dispatched QA pod (run id + the work item it tests). */
export class QaDispatchDto implements QaDispatch {
  @ApiProperty({ description: 'Run id of the dispatched QA pod.' })
  runId!: string;

  @ApiProperty({ description: 'Work item (Story or Bug) the pod tests.' })
  workItemId!: string;

  @ApiProperty({
    required: false,
    description: 'Work-item title, so the UI can name what it tests.',
  })
  title?: string;

  @ApiProperty({
    required: false,
    enum: ['story', 'bug'],
    description: 'First test of a finished Story, or a retest of a fixed Bug.',
  })
  kind?: 'story' | 'bug';
}

/** Summary of a QA batch dispatch wave (one pod fanned out per Ready-for-QA item). */
export class QaBatchResponseDto {
  @ApiProperty({
    description:
      'Total Ready-for-QA candidates enumerated (Stories in Done + Bugs awaiting retest).',
  })
  candidates!: number;

  @ApiProperty({ type: [QaDispatchDto], description: 'Pods dispatched this wave (one per item).' })
  dispatched!: QaDispatchDto[];

  @ApiProperty({ description: 'Number of pods dispatched this wave.' })
  dispatchedCount!: number;

  @ApiProperty({
    type: [String],
    description: 'Items skipped — a run is already active (idempotent).',
  })
  skippedActive!: string[];

  @ApiProperty({
    type: [String],
    description: 'Eligible items deferred to a later wave (over the concurrency cap).',
  })
  deferred!: string[];

  @ApiProperty({
    description: 'Items not dispatched with the reason (not a Story/Bug, not ready for QA, …).',
  })
  ineligible!: { workItemId: string; reason: string }[];

  @ApiProperty({
    description:
      'True when this was a preview: `dispatched` lists what would run and nothing was started.',
  })
  dryRun!: boolean;

  static fromResult(result: QaBatchResult): QaBatchResponseDto {
    return {
      candidates: result.candidates,
      dispatched: result.dispatched.map((d) => ({
        runId: d.runId,
        workItemId: d.workItemId,
        title: d.title,
        kind: d.kind,
      })),
      dispatchedCount: result.dispatched.length,
      skippedActive: result.skippedActive,
      deferred: result.deferred,
      ineligible: result.ineligible,
      dryRun: result.dryRun,
    };
  }
}

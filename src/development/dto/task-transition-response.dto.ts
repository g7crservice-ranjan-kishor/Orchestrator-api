import { ApiProperty } from '@nestjs/swagger';
import {
  OutcomeStatus,
  TaskTransitionOutcome,
  TaskTransitionResult,
  TransitionTarget,
} from '../task-transition.service';

const OUTCOME_STATUSES: OutcomeStatus[] = ['succeeded', 'blocked', 'failed', 'skipped'];

/** What happened to one Task — bulk operations report each Task independently. */
export class TaskTransitionOutcomeDto implements TaskTransitionOutcome {
  @ApiProperty({ description: 'Board card key (ADO work-item id, or draft backlog item id).' })
  taskKey!: string;

  @ApiProperty({ nullable: true, description: 'ADO work-item id once the Task exists in ADO.' })
  adoId!: number | null;

  @ApiProperty({ description: 'Task title.' })
  title!: string;

  @ApiProperty({ description: 'Source status.' })
  from!: string;

  @ApiProperty({ description: 'Target status.' })
  to!: string;

  @ApiProperty({
    enum: OUTCOME_STATUSES,
    description:
      'succeeded = moved; blocked = a business rule rejected it; skipped = nothing to do (already running / deferred); failed = attempted and errored.',
  })
  status!: OutcomeStatus;

  @ApiProperty({ description: 'Convenience flag — true only when status is `succeeded`.' })
  ok!: boolean;

  @ApiProperty({
    required: false,
    description: 'Why it was blocked/failed, or a caveat on a partial success.',
  })
  reason?: string;

  @ApiProperty({ required: false, description: 'The suggested next step, when there is one.' })
  hint?: string;

  @ApiProperty({
    required: false,
    description: 'Developer run started (To Do → In Progress only).',
  })
  runId?: string;

  @ApiProperty({ required: false, nullable: true, description: "The Task's sprint." })
  sprint?: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'The resolved execution agent.' })
  executionAgent?: string | null;
}

/** Result of one board transition operation (single card, bulk selection, or drag-and-drop). */
export class TaskTransitionResponseDto implements TaskTransitionResult {
  @ApiProperty({ description: 'Correlates every Task in this operation in the audit trail.' })
  bulkOperationId!: string;

  @ApiProperty({ description: 'Target status the operation requested.' })
  to!: TransitionTarget;

  @ApiProperty({ description: 'True when this was a validation preview — nothing was changed.' })
  dryRun!: boolean;

  @ApiProperty({ description: 'How many Tasks were selected.' })
  requested!: number;

  @ApiProperty({ description: 'How many transitioned successfully.' })
  succeeded!: number;

  @ApiProperty({ description: 'How many a business rule rejected.' })
  blocked!: number;

  @ApiProperty({ description: 'How many were attempted and errored.' })
  failed!: number;

  @ApiProperty({ description: 'How many had nothing to do (already running / deferred).' })
  skipped!: number;

  @ApiProperty({ type: [TaskTransitionOutcomeDto], description: 'Per-Task result.' })
  outcomes!: TaskTransitionOutcomeDto[];
}

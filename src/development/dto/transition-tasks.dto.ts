import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TransitionSource, TransitionTarget } from '../task-transition.service';

/** How the transition was initiated — recorded in the audit trail. */
export const TRANSITION_SOURCES: TransitionSource[] = ['button', 'drag-drop', 'bulk'];

/** The only statuses a user may move a Task **to** — `Done` is orchestrator-owned and rejected here. */
export const USER_TRANSITION_TARGETS: TransitionTarget[] = ['To Do', 'In Progress'];

/** Request to transition one Task (single card) or many (bulk action) on the Development board. */
export class TransitionTasksDto {
  @ApiProperty({
    type: [String],
    description:
      'Board card keys to transition: the Azure DevOps work-item id, or the draft backlog item id for a Task that is not in ADO yet.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  taskKeys!: string[];

  @ApiProperty({
    enum: USER_TRANSITION_TARGETS,
    description:
      'Target status. `To Do` approves Draft Task(s) for development; `In Progress` dispatches them to the Claude Developer Agent. `Done` is never accepted — only the orchestrator completes a Task, after a successful agent run.',
  })
  @IsIn(USER_TRANSITION_TARGETS)
  to!: TransitionTarget;

  @ApiProperty({
    required: false,
    description:
      'Validate only: returns exactly which Tasks are eligible and why the rest are blocked, without changing anything. Backs the bulk confirmation dialog.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiProperty({
    required: false,
    enum: TRANSITION_SOURCES,
    description: 'How the user initiated this transition (recorded in the audit trail).',
  })
  @IsOptional()
  @IsIn(TRANSITION_SOURCES)
  source?: TransitionSource;
}

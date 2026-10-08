import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/**
 * Audit action verbs. Kept as a closed set so the audit trail is queryable and stable across
 * releases (DEVELOPMENT_GUIDELINES.md — no stringly-typed events).
 */
export enum AuditAction {
  ProjectCreated = 'project.created',
  RequirementSubmitted = 'requirement.submitted',
  EmPlanningStarted = 'planning.em.started',
  ClarificationAnswered = 'planning.clarification.answered',
  PlanApproved = 'planning.plan.approved',
  PlanRegenerated = 'planning.plan.regenerated',
  SmBacklogStarted = 'planning.sm.started',
  BacklogEdited = 'backlog.edited',
  DraftApproved = 'approval.draft.approved',
  AdoTargetConfirmed = 'approval.adoTarget.confirmed',
  AdoPushCompleted = 'ado.push.completed',
  DevelopmentStarted = 'development.started',
  DevelopmentBatchStarted = 'development.batch.started',
  /** Board: Draft → To Do (a human approved Task(s) for development). */
  TaskApproved = 'task.approved',
  /** Board: To Do → In Progress (a human dispatched Task(s) to the Developer Agent). */
  TaskDevelopmentStarted = 'task.development.started',
  /** Orchestrator-owned: In Progress → Done after the agent completed successfully. */
  TaskCompleted = 'task.completed',
  /** Orchestrator-owned: a Developer run failed — the Task stays put, it never becomes Done. */
  TaskExecutionFailed = 'task.execution.failed',
  /** A human supplied one of the generated application's runtime credentials (name only, never the value). */
  AppSecretProvided = 'app.secret.provided',
  /** Orchestrator-owned: a Story moved to Committed because development started on one of its Tasks. */
  StoryDevelopmentStarted = 'story.development.started',
  /** Orchestrator-owned: every Task is Done — the Story is Done, which is the Ready-for-QA signal. */
  StoryReadyForQa = 'story.ready_for_qa',
  /** Board: the active sprint was closed and the next one started (iteration dates moved in ADO). */
  SprintCompleted = 'sprint.completed',
  OrchestrationDispatch = 'orchestration.dispatch',
  QaBatchStarted = 'qa.batch.started',
}

/**
 * One immutable audit entry. Records **who** (actor) did **what** (action) to **which** entity,
 * **when** (createdAt), with optional structured context. The collection is append-only: the
 * schema blocks updates/deletes via pre-hooks (WORKFLOW.md §5, PROJECT_OVERVIEW.md §7). There is
 * intentionally no `updatedAt` — entries never change.
 */
@Schema({ collection: 'auditLog', timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  /** Acting user id (null for system/automated actions such as a run ingest). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  actorId!: Types.ObjectId | null;

  /** Acting user's email (denormalised so the trail is readable without a join). */
  @Prop({ type: String, default: 'system' })
  actorEmail!: string;

  @Prop({ type: String, enum: AuditAction, required: true, index: true })
  action!: AuditAction;

  /** The kind of entity acted on (e.g. 'draft', 'project', 'backlogItem'). */
  @Prop({ required: true })
  entityType!: string;

  /** The entity's id (Mongo id, backlog item id, or ADO id as a string). */
  @Prop({ required: true })
  entityId!: string;

  /** Project scope for filtering the trail; null for cross-project actions. */
  @Prop({ type: Types.ObjectId, ref: 'Project', default: null, index: true })
  projectId!: Types.ObjectId | null;

  /** Structured, non-sensitive context (never secrets). */
  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

// Enforce immutability: an audit entry may be inserted and read, never modified or removed.
const IMMUTABLE = 'Audit log is append-only; entries cannot be modified or deleted.';
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndReplace',
] as const) {
  AuditLogSchema.pre(op, function blockMutation() {
    throw new Error(IMMUTABLE);
  });
}

// Re-saving an already-persisted entry is a mutation; only the initial insert is allowed.
AuditLogSchema.pre('save', function blockResave(next) {
  if (!this.isNew) {
    next(new Error(IMMUTABLE));
    return;
  }
  next();
});

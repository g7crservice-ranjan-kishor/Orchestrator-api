import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DevQueueItemState, DevQueueStatus } from '../../development/schemas/dev-queue.schema';

export type QaQueueDocument = HydratedDocument<QaQueue>;

/*
 * The item and queue states are the Development queue's, deliberately.
 *
 * A queue that drains one run at a time has the same four item states and the same three queue
 * states whatever the runs are for, and the sequencing rules live in one place
 * (`dev-queue.decisions`). Re-declaring the vocabulary here would let the two drift — and the board
 * shows them side by side, so a divergence would be visible to the person and meaningless to them.
 */
export { DevQueueItemState as QaQueueItemState, DevQueueStatus as QaQueueStatus };

@Schema({ _id: false })
export class QaQueueItem {
  /** The ADO work item id (a Story, or a Bug awaiting retest), as the jobs table keys it. */
  @Prop({ required: true })
  workItemId!: string;

  /** Requested order, preserved exactly as the person selected it. */
  @Prop({ required: true })
  position!: number;

  @Prop({ required: true, enum: Object.values(DevQueueItemState) })
  state!: DevQueueItemState;

  /** The QA run testing this item; null while it is still waiting. */
  @Prop({ type: String, default: null })
  runId!: string | null;

  @Prop({ type: Date, default: null })
  startedAt!: Date | null;

  @Prop({ type: Date, default: null })
  finishedAt!: Date | null;

  /**
   * Why this entry ended the way it did, when that is not obvious from its state.
   *
   * Set when a Story is **skipped** — it could never start, so the wave stepped over it. Without
   * somewhere to put the reason, skipping would be strictly worse than the halt it replaces: the
   * queue would carry on and the Story would simply be missing, with nothing on the board saying
   * why.
   */
  @Prop({ type: String, default: null })
  note!: string | null;
}

export const QaQueueItemSchema = SchemaFactory.createForClass(QaQueueItem);

/**
 * An ordered batch of Stories a person asked to test, drained one QA run at a time.
 *
 * Before this existed, a QA wave dispatched as many items as the concurrency cap allowed — one —
 * and returned the rest in a `deferred` list that nothing ever read. The scheduler built to drain
 * it is off by default (`ORCHESTRATION_ENABLED=false`), so selecting twenty Stories tested one and
 * silently dropped nineteen. This is the memory that makes the other nineteen happen.
 *
 * Like the Development queue it is **not** a second execution engine: every start still goes
 * through `QaService.startQaBatch`, and the concurrency cap still decides when anything may run.
 */
@Schema({ collection: 'qaqueues', timestamps: true })
export class QaQueue {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId!: Types.ObjectId;

  /** Correlates with the bulk operation recorded in the audit trail. */
  @Prop({ required: true })
  batchId!: string;

  @Prop({ type: [QaQueueItemSchema], default: [] })
  items!: QaQueueItem[];

  @Prop({ required: true, enum: Object.values(DevQueueStatus), default: DevQueueStatus.Active })
  status!: DevQueueStatus;

  /** Why the queue stopped, shown to the person who has to decide whether to resume. */
  @Prop({ type: String, default: null })
  haltedReason!: string | null;

  /** Who started it — the queue dispatches on their behalf long after the request ended. */
  @Prop({ type: String, default: null })
  actorId!: string | null;

  @Prop({ default: 'system' })
  actorEmail!: string;
}

export const QaQueueSchema = SchemaFactory.createForClass(QaQueue);

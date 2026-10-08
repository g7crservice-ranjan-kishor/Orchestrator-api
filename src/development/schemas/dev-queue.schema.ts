import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DevQueueDocument = HydratedDocument<DevQueue>;

/** Where one selected Task stands in the queue. */
export enum DevQueueItemState {
  Queued = 'queued',
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
}

/** Whether the queue is still feeding work, stopped by a failure, or finished. */
export enum DevQueueStatus {
  Active = 'active',
  Halted = 'halted',
  Finished = 'finished',
}

@Schema({ _id: false })
export class DevQueueItem {
  /** The ADO work item id, as a string — the same key the board and the jobs table use. */
  @Prop({ required: true })
  workItemId!: string;

  /** Requested execution order, preserved exactly as the user selected it. */
  @Prop({ required: true })
  position!: number;

  @Prop({ required: true, enum: Object.values(DevQueueItemState) })
  state!: DevQueueItemState;

  /** The run that executed (or is executing) this item; null while it is still waiting. */
  @Prop({ type: String, default: null })
  runId!: string | null;

  /**
   * Why this entry is where it is, when the state alone does not say.
   *
   * Set when a Task is **waiting** for work it depends on (and still Queued), or when it was
   * stepped over because it could never start. Without somewhere to put the reason, skipping would
   * be worse than the halt it replaces: the wave would carry on and the Task would simply be
   * missing, with nothing on the board explaining why.
   */
  @Prop({ type: String, default: null })
  note!: string | null;

  @Prop({ type: Date, default: null })
  startedAt!: Date | null;

  @Prop({ type: Date, default: null })
  finishedAt!: Date | null;
}

export const DevQueueItemSchema = SchemaFactory.createForClass(DevQueueItem);

/**
 * An ordered batch of Tasks a person asked to develop, drained one run at a time.
 *
 * This is a *memory*, not a second execution engine. Dispatch still happens through the existing
 * Developer path, and the concurrency cap still decides how many runs may exist — the queue only
 * records which Tasks were chosen, in what order, so the ones the cap deferred are picked up when a
 * run finishes instead of being forgotten the moment the response is rendered.
 *
 * One active queue per project, which is what makes "refresh the page and the order is still there"
 * true, and what stops two selections racing each other.
 */
@Schema({ collection: 'devqueues', timestamps: true })
export class DevQueue {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId!: Types.ObjectId;

  /** Correlates with the bulk operation recorded in the audit trail. */
  @Prop({ required: true })
  batchId!: string;

  @Prop({ type: [DevQueueItemSchema], default: [] })
  items!: DevQueueItem[];

  @Prop({ required: true, enum: Object.values(DevQueueStatus), default: DevQueueStatus.Active })
  status!: DevQueueStatus;

  /** Why the queue stopped feeding, shown to the person who has to decide whether to resume. */
  @Prop({ type: String, default: null })
  haltedReason!: string | null;

  /** Who started it — the queue dispatches on their behalf long after the request ended. */
  @Prop({ type: String, default: null })
  actorId!: string | null;

  @Prop({ default: 'system' })
  actorEmail!: string;
}

export const DevQueueSchema = SchemaFactory.createForClass(DevQueue);

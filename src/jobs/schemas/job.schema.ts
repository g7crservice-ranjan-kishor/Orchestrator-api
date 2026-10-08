import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { JobRole, JobState, PermissionMode } from '../job-state';

export type JobDocument = HydratedDocument<Job>;

/** Lease held by the runner currently processing a job (heartbeat + expiry). */
@Schema({ _id: false })
export class Lease {
  @Prop({ type: String, default: null })
  runnerId!: string | null;

  @Prop({ type: Date, default: null })
  acquiredAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastHeartbeatAt!: Date | null;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;
}
export const LeaseSchema = SchemaFactory.createForClass(Lease);

/** Run Result recorded when a job reaches a terminal state (ARCHITECTURE.md §6). */
@Schema({ _id: false })
export class RunResult {
  @Prop({ type: Number, default: 0 })
  durationMs!: number;

  @Prop({ type: Number, default: 0 })
  tokens!: number;

  @Prop({ type: Number, default: 0 })
  cost!: number;

  @Prop({ type: String, default: null })
  logsRef!: string | null;

  /** Tail of the agent's final message (truncated). Null for runs that reported none. */
  @Prop({ type: String, default: null })
  output!: string | null;

  /** Build stamp of the worker image that ran this job. Null for runs that reported none. */
  @Prop({ type: String, default: null })
  workerBuild!: string | null;

  @Prop({ type: Number, default: 0 })
  filesChanged!: number;

  /** Commit SHAs the developer run pushed to the configured branch (empty for planning runs). */
  @Prop({ type: [String], default: [] })
  commits!: string[];

  /** Azure DevOps changes the run made (e.g. work-item transitions via the in-pod ADO MCP). */
  @Prop({ type: [String], default: [] })
  adoChanges!: string[];

  /** Artifact references (Blob refs for logs/outputs; empty in Milestone 1). */
  @Prop({ type: [String], default: [] })
  artifacts!: string[];

  /** In-pod workspace path the run used (ARCHITECTURE.md §6 Run Result contract). */
  @Prop({ type: String, default: null })
  workspacePath!: string | null;
}
export const RunResultSchema = SchemaFactory.createForClass(RunResult);

/**
 * A planning job dispatched to the Agent Runner. The jobs collection is the Milestone-1 record of
 * work (no message broker yet); lease + heartbeat provide at-most-one active runner per job, and
 * `workItemId` enforces one active run per work item.
 */
@Schema({ collection: 'jobs', timestamps: true, optimisticConcurrency: true })
export class Job {
  @Prop({ required: true, unique: true, index: true })
  runId!: string;

  @Prop({ type: String, enum: JobRole, required: true })
  role!: JobRole;

  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId!: Types.ObjectId;

  @Prop({ type: String, default: null, index: true })
  workItemId!: string | null;

  @Prop({ type: String, default: null })
  repo!: string | null;

  @Prop({ type: String, enum: PermissionMode, required: true })
  permissionMode!: PermissionMode;

  @Prop({ type: String, enum: JobState, default: JobState.Queued, index: true })
  state!: JobState;

  @Prop({ type: LeaseSchema, default: () => ({}) })
  lease!: Lease;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: RunResultSchema, default: null })
  result!: RunResult | null;

  @Prop({ type: String, default: null })
  blockedReason!: string | null;
}

export const JobSchema = SchemaFactory.createForClass(Job);

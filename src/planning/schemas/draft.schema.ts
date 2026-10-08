import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DraftDocument = HydratedDocument<Draft>;

/** Where a project sits in the planning pipeline (WORKFLOW.md §2). */
/**
 * Whether a draft is the product's first plan or a later change to it.
 *
 * A project used to have exactly one plan, enforced by a unique index on `projectId`. That is
 * right for building a product once and wrong the moment someone wants to add to it: planning
 * again would overwrite the plan that is already in Azure DevOps and throw away every `adoId` with
 * it. An enhancement is therefore a *separate* planning cycle — which is what lets the EM session,
 * the backlog gates, the push and both queues work on it unchanged.
 */
export enum DraftKind {
  /** The product's first plan. Exactly one per project. */
  Initial = 'initial',
  /** A change to a product that has already been planned. ENH-001, ENH-002, … */
  Enhancement = 'enhancement',
}

export enum DraftStatus {
  Intake = 'intake',
  Clarifying = 'clarifying',
  Planning = 'planning',
  Planned = 'planned',
  BacklogDrafting = 'backlogDrafting',
  BacklogDrafted = 'backlogDrafted',
  Approved = 'approved',
}

/** Framework work-item types in the draft hierarchy (Epic → Feature → Story → Task). */
export enum BacklogItemType {
  Epic = 'epic',
  Feature = 'feature',
  Story = 'story',
  Task = 'task',
}

/**
 * One technical decision a product cannot be built without, and where its value came from.
 *
 * Stored on the draft rather than recomputed, because the source matters as much as the value: a
 * reader needs to tell "React, because you said so" from "React, because nobody said otherwise".
 * A value a person typed is also an answer that must survive the next re-plan.
 */
@Schema({ _id: false })
export class TechnicalDetail {
  @Prop({ required: true })
  field!: string;

  @Prop({ required: true })
  label!: string;

  @Prop({ type: String, default: null })
  value!: string | null;

  /** `requirement` | `project` | `user` | `missing`. */
  @Prop({ required: true })
  source!: string;

  @Prop({ type: Boolean, default: true })
  required!: boolean;

  @Prop({ default: '' })
  question!: string;
}
export const TechnicalDetailSchema = SchemaFactory.createForClass(TechnicalDetail);

/** One clarification exchange in the EM thread. */
@Schema({ _id: false })
export class Clarification {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  question!: string;

  @Prop({ type: String, default: null })
  answer!: string | null;

  @Prop({ type: Date, default: null })
  answeredAt!: Date | null;

  /*
   * What the question is about, why it is being asked, and what happens if it is not answered.
   *
   * A bare list of questions is hard to work through and easy to abandon: nothing says which are
   * about the data model and which about an edge case, nothing says what breaks if one is skipped,
   * and nothing says what the agent will do in the absence of an answer. All three are optional,
   * so questions recorded before this existed still read correctly.
   */

  /** One of CLARIFICATION_CATEGORIES; anything unrecognised reads as 'functional'. */
  @Prop({ type: String, default: 'functional' })
  category!: string;

  /** What goes wrong if nobody answers — the test of whether it was worth asking. */
  @Prop({ type: String, default: null })
  why!: string | null;

  /** What will be assumed if it goes unanswered, so silence is still an informed choice. */
  @Prop({ type: String, default: null })
  assumption!: string | null;
}
export const ClarificationSchema = SchemaFactory.createForClass(Clarification);

/**
 * One credential the **generated application** needs at runtime, as declared during planning.
 *
 * Only the *name* and *purpose* live here. The **value never touches MongoDB** — it is written
 * straight to Key Vault (`no secrets in repo/Mongo`), and nothing reads it back out except the pod
 * that needs it. `provided` is the only thing the UI and the approval gate ever see.
 */
@Schema({ _id: false })
export class RequiredSecret {
  /** Environment variable name the application reads, e.g. `DATABASE_URL`. */
  @Prop({ required: true })
  name!: string;

  /** What it is and where to get it, so a human can answer without reading the plan. */
  @Prop({ default: '' })
  description!: string;

  /** A non-secret illustration of the shape, e.g. `postgres://user:pass@host:5432/db`. */
  @Prop({ default: '' })
  example!: string;

  /** True once a value has been stored in Key Vault. Never the value itself. */
  @Prop({ type: Boolean, default: false })
  provided!: boolean;

  @Prop({ type: Date, default: null })
  providedAt!: Date | null;
}
export const RequiredSecretSchema = SchemaFactory.createForClass(RequiredSecret);

/** Attachment metadata on a backlog item (bytes live in Blob). */
@Schema({ _id: false })
export class ItemAttachment {
  @Prop({ required: true }) originalName!: string;
  @Prop({ required: true }) url!: string;
  @Prop({ required: true }) contentType!: string;
  @Prop({ required: true }) size!: number;
}
export const ItemAttachmentSchema = SchemaFactory.createForClass(ItemAttachment);

/** An editable backlog draft card. `id`/`parentId` are client-stable ids (not Mongo _id). */
@Schema({ _id: false })
export class BacklogItem {
  @Prop({ required: true }) id!: string;

  @Prop({ type: String, enum: BacklogItemType, required: true })
  type!: BacklogItemType;

  @Prop({ required: true }) title!: string;
  @Prop({ default: '' }) description!: string;
  @Prop({ default: '' }) acceptanceCriteria!: string;

  @Prop({ type: String, default: null })
  parentId!: string | null;

  @Prop({ default: 0 }) order!: number;
  @Prop({ default: 2 }) priority!: number;
  @Prop({ type: Number, default: null }) estimate!: number | null;

  @Prop({ type: [String], default: [] })
  dependsOn!: string[];

  @Prop({ type: String, default: null }) repo!: string | null;
  @Prop({ type: String, default: null }) sprint!: string | null;

  @Prop({ type: [ItemAttachmentSchema], default: [] })
  attachments!: ItemAttachment[];

  /** ADO work-item id once this item has been created in Azure DevOps (idempotency key). */
  @Prop({ type: Number, default: null }) adoId!: number | null;
}
export const BacklogItemSchema = SchemaFactory.createForClass(BacklogItem);

/** The ADO target confirmed at approval (snapshot; the project target may change afterwards). */
@Schema({ _id: false })
export class ConfirmedAdoTarget {
  @Prop({ required: true }) orgUrl!: string;
  @Prop({ required: true }) project!: string;
  @Prop({ required: true }) areaPath!: string;
}
export const ConfirmedAdoTargetSchema = SchemaFactory.createForClass(ConfirmedAdoTarget);

/**
 * The approval + ADO-target-confirmation gate (WORKFLOW.md §4). No Azure DevOps write may happen
 * until `approved` and `adoTargetConfirmed` are both true; `pushedToAdo` records that the one-way
 * push has completed so it is not repeated.
 */
@Schema({ _id: false })
export class ApprovalState {
  @Prop({ type: Boolean, default: false }) approved!: boolean;
  @Prop({ type: String, default: null }) approvedBy!: string | null;
  @Prop({ type: Date, default: null }) approvedAt!: Date | null;

  @Prop({ type: Boolean, default: false }) adoTargetConfirmed!: boolean;
  @Prop({ type: ConfirmedAdoTargetSchema, default: null })
  confirmedTarget!: ConfirmedAdoTarget | null;
  @Prop({ type: String, default: null }) confirmedBy!: string | null;
  @Prop({ type: Date, default: null }) confirmedAt!: Date | null;

  @Prop({ type: Boolean, default: false }) pushedToAdo!: boolean;
  @Prop({ type: Date, default: null }) pushedAt!: Date | null;
}
export const ApprovalStateSchema = SchemaFactory.createForClass(ApprovalState);

/**
 * The per-project planning draft: EM clarification thread + plan.md + editable backlog. Drafts
 * live in MongoDB until approval; nothing reaches Azure DevOps until the admin approves and
 * confirms the ADO target (ARCHITECTURE.md §1, PROJECT_OVERVIEW.md §6).
 */
@Schema({ collection: 'drafts', timestamps: true })
export class Draft {
  /**
   * Not unique any more — see {@link DraftKind}. Uniqueness is now `projectId` + `seq`, so a project
   * has one initial plan and as many enhancements as it needs, each numbered once.
   */
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId!: Types.ObjectId;

  @Prop({ type: String, enum: DraftKind, default: DraftKind.Initial })
  kind!: DraftKind;

  /**
   * Position in the project's planning history: `0` is the initial plan, `1` the first enhancement.
   * It is what ENH-001 counts, so it is assigned once and never reused.
   */
  @Prop({ type: Number, default: 0 })
  seq!: number;

  /** What this enhancement is called ("Implement Dark Mode"). Null for the initial plan. */
  @Prop({ type: String, default: null })
  title!: string | null;

  /**
   * Where an enhancement's first sprint lands: the sprint running now, or the one after.
   *
   * `current` by default because an enhancement is normally wanted now, and work that cannot start
   * until the next rollover is work nobody is doing. A team that keeps its sprint boundaries clean
   * chooses `next` instead, so the burndown of a sprint in flight is not disturbed.
   */
  @Prop({ type: String, enum: ['current', 'next'], default: 'current' })
  sprintAnchor!: 'current' | 'next';

  @Prop({ type: Types.ObjectId, ref: 'Requirement', default: null })
  requirementId!: Types.ObjectId | null;

  @Prop({ type: String, enum: DraftStatus, default: DraftStatus.Intake })
  status!: DraftStatus;

  @Prop({ type: [ClarificationSchema], default: [] })
  clarifications!: Clarification[];

  /**
   * The product's technical decisions, resolved from the requirement, the project and the person.
   *
   * Empty until a requirement is read. Planning must not finalise a plan while a **required**
   * detail is still `missing`: a stack nobody chose is a stack the agent chooses, and that is how
   * a plan came to name PostgreSQL for a project pinned to SQL Server.
   */
  @Prop({ type: [TechnicalDetailSchema], default: [] })
  technicalDetails!: TechnicalDetail[];

  @Prop({ type: String, default: null })
  planMarkdown!: string | null;

  /**
   * Credentials the generated application will need at runtime, declared by the EM during planning.
   * Every one must be provided before the plan can be approved (D-029).
   */
  @Prop({ type: [RequiredSecretSchema], default: [] })
  requiredSecrets!: RequiredSecret[];

  @Prop({ type: Boolean, default: false })
  planApproved!: boolean;

  /** Admin "request changes" feedback carried into the next EM regeneration (cleared after use). */
  @Prop({ type: String, default: null })
  planFeedback!: string | null;

  /**
   * What the last generated plan was missing against the project's binding choices. Empty when
   * the plan is complete. Surfaced in the UI so a plan that slipped through is impossible to
   * miss rather than something you find by reading a queue days later.
   */
  @Prop({ type: [String], default: [] })
  planIssues!: string[];

  /** Automatic regeneration attempts already spent on this requirement. Bounded; see D-037. */
  @Prop({ type: Number, default: 0 })
  planAttempts!: number;

  /** The same budget, for the backlog. */
  @Prop({ type: Number, default: 0 })
  backlogAttempts!: number;

  /**
   * True while a correction run is in flight. The backlog it returns is **merged** into the
   * existing one rather than replacing it, so a correction can add what is missing but cannot
   * drop what was already right (D-039).
   */
  @Prop({ type: Boolean, default: false })
  backlogCorrection!: boolean;

  /** How many blocking issues the previous backlog had. Reported, not used to decide anything. */
  @Prop({ type: Number, default: 0 })
  backlogLastErrors!: number;

  /**
   * Which blocking issues the previous backlog had, as a comparable fingerprint.
   *
   * Corrections continue while the *set* of issues keeps changing, and stop when a round comes
   * back with exactly the same ones — that is what "stuck" means. Counting instead was wrong: the
   * Scrum Master fixes several items a round and often trips a different rule doing it (moving a
   * Task's sprint can breach a dependency), so a round that genuinely made progress showed the
   * same total and was read as stuck. Every product stopped at two attempts out of a budget of
   * eight, every time.
   */
  @Prop({ type: String, default: '' })
  backlogErrorSignature!: string;

  /**
   * Why the last run left nothing behind, when it left nothing behind. A run that finishes
   * without producing a plan or a backlog used to leave the draft saying "an agent is working"
   * indefinitely; this is what the screen shows instead.
   */
  @Prop({ type: String, default: null })
  runNote!: string | null;

  @Prop({ type: [BacklogItemSchema], default: [] })
  backlog!: BacklogItem[];

  @Prop({ type: Boolean, default: false })
  backlogApproved!: boolean;

  /** Approval + ADO-target-confirmation gate; ADO writes are blocked until it is satisfied. */
  @Prop({ type: ApprovalStateSchema, default: () => ({}) })
  approval!: ApprovalState;

  /** The run currently producing plan/backlog (correlates ingest to this draft). */
  @Prop({ type: String, default: null, index: true })
  currentRunId!: string | null;
}

export const DraftSchema = SchemaFactory.createForClass(Draft);

/*
 * One plan per position, per project.
 *
 * Replaces the old unique index on `projectId` alone, which allowed a project exactly one plan for
 * ever. The old index is **not** dropped by Mongoose — `scripts/migrate-draft-index.js` does that,
 * and until it has run a second draft cannot be inserted.
 */
DraftSchema.index({ projectId: 1, seq: 1 }, { unique: true });

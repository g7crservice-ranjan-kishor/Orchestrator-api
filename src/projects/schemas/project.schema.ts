import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DATABASE_IDS, DEFAULT_DATABASE, DatabaseChoice } from '../database-choice';
import { DEFAULT_UI_STYLE, UI_STYLE_IDS, UiStyleChoice } from '../ui-style-choice';

export type ProjectDocument = HydratedDocument<Project>;

/**
 * The Azure DevOps target for a project. One area path per project (ARCHITECTURE.md §8); the
 * target repo is a per-task attribute, so a project carries the list of allowed repos.
 */
@Schema({ _id: false })
export class AdoTarget {
  @Prop({ required: true })
  orgUrl!: string;

  @Prop({ required: true })
  project!: string;

  @Prop({ required: true })
  areaPath!: string;
}

export const AdoTargetSchema = SchemaFactory.createForClass(AdoTarget);

/**
 * A project groups a requirement, its plan/backlog drafts, and the ADO target used at approval.
 * Phase 1 stores the target and the selectable target repositories; work-item creation happens
 * later at the approval gate.
 */
/** How to start this product, so the orchestrator can verify it actually works. */
@Schema({ _id: false })
export class VerificationSettings {
  /** Command that starts the API, run in its repository. */
  @Prop({ default: 'npm run dev' })
  apiStartCommand!: string;

  /** Command that applies the database schema; empty when the project has no migrations. */
  @Prop({ default: '' })
  migrateCommand!: string;

  /** Where the API is expected to listen once started. */
  @Prop({ default: 'http://localhost:3000' })
  apiUrl!: string;

  /** Path that proves the API is up. */
  @Prop({ default: '/health' })
  healthPath!: string;

  /** The origin a browser serves the interface from — what the CORS check asks about. */
  @Prop({ default: 'http://localhost:5173' })
  uiOrigin!: string;
}

export const VerificationSettingsSchema = SchemaFactory.createForClass(VerificationSettings);

@Schema({ collection: 'projects', timestamps: true })
export class Project {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ type: AdoTargetSchema, required: true })
  adoTarget!: AdoTarget;

  /** Repositories a task may target (recorded as a per-task tag downstream). */
  @Prop({ type: [String], default: [] })
  targetRepos!: string[];

  /**
   * The database the generated application is built against. The default applies to projects
   * created before this field existed, so every project has an answer without a migration.
   */
  @Prop({ type: String, enum: DATABASE_IDS, default: DEFAULT_DATABASE })
  database!: DatabaseChoice;

  /**
   * How the generated user interface is built and styled. Without it an agent ships a working but
   * unstyled application, because nothing else in the pipeline ever asks for a look.
   */
  @Prop({ type: String, enum: UI_STYLE_IDS, default: DEFAULT_UI_STYLE })
  uiStyle!: UiStyleChoice;

  /**
   * Whether this project has its own Azure DevOps token.
   *
   * The token itself lives only in Key Vault — never in this document, never in a response. This
   * flag exists so the interface can say "configured" without the value ever leaving the vault.
   * A project without one falls back to the platform token, which is how every project worked
   * before this existed.
   */
  @Prop({ default: false })
  adoPatConfigured!: boolean;

  /**
   * How the orchestrator starts this product to verify it end to end.
   *
   * Every other gate judges one repository in isolation, so the defects that reached users lived
   * between two of them — no CORS, a mismatched port, a response shape the interface never read.
   * Verifying means actually starting the thing, and the orchestrator cannot guess how: the
   * defaults suit a Node project and any project that differs sets its own, once.
   */
  @Prop({ type: VerificationSettingsSchema, default: () => ({}) })
  verification!: VerificationSettings;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  createdBy!: Types.ObjectId;
}

export const ProjectSchema = SchemaFactory.createForClass(Project);

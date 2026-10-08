import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RequirementDocument = HydratedDocument<Requirement>;

/** Requirement lifecycle status (Phase 1 planning path). */
export enum RequirementStatus {
  Draft = 'draft',
  Submitted = 'submitted',
}

/** An uploaded attachment stored in Blob (metadata only; bytes live in Blob). */
@Schema({ _id: false })
export class Attachment {
  @Prop({ required: true })
  blobName!: string;

  @Prop({ required: true })
  originalName!: string;

  @Prop({ required: true })
  contentType!: string;

  @Prop({ required: true })
  size!: number;

  @Prop({ required: true })
  url!: string;
}

export const AttachmentSchema = SchemaFactory.createForClass(Attachment);

/**
 * A requirement submitted against a project — free text plus optional document attachments. It is
 * the input to the EM planning session (no side effects until approval).
 */
@Schema({ collection: 'requirements', timestamps: true })
export class Requirement {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId!: Types.ObjectId;

  @Prop({ default: '' })
  text!: string;

  @Prop({ type: [AttachmentSchema], default: [] })
  attachments!: Attachment[];

  @Prop({ type: String, enum: RequirementStatus, default: RequirementStatus.Submitted })
  status!: RequirementStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy!: Types.ObjectId;

  /**
   * Written by `timestamps: true` above, declared here so it can be read without a cast.
   *
   * The intake list orders by it and shows how long ago each requirement was submitted, which is
   * the only way to tell two similarly worded requirements apart at a glance.
   */
  createdAt?: Date;
}

export const RequirementSchema = SchemaFactory.createForClass(Requirement);

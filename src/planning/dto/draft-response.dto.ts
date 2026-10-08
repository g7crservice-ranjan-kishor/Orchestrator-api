import { ApiProperty } from '@nestjs/swagger';
import { draftLabel } from '../draft-selection';
import { TECHNICAL_FIELD_OPTIONS } from '../technical-details';
import {
  BacklogItem,
  Clarification,
  DraftDocument,
  TechnicalDetail,
  DraftKind,
  DraftStatus,
  RequiredSecret,
} from '../schemas/draft.schema';

/** Approval + ADO-target-confirmation gate state, projected for the admin UI. */
export class ApprovalStateDto {
  @ApiProperty() approved!: boolean;
  @ApiProperty({ nullable: true }) approvedBy!: string | null;
  @ApiProperty({ nullable: true }) approvedAt!: string | null;
  @ApiProperty() adoTargetConfirmed!: boolean;
  @ApiProperty({ nullable: true, additionalProperties: true })
  confirmedTarget!: { orgUrl: string; project: string; areaPath: string } | null;
  @ApiProperty({ nullable: true }) confirmedBy!: string | null;
  @ApiProperty({ nullable: true }) confirmedAt!: string | null;
  @ApiProperty() pushedToAdo!: boolean;
  @ApiProperty({ nullable: true }) pushedAt!: string | null;
}

/** Draft projection returned to the admin UI. */
/**
 * Attaches each detail its list of usual answers on the way out.
 *
 * Derived at response time rather than stored, so a vocabulary that gains an entry does not leave
 * every draft written before it offering a shorter list than the one the detector uses.
 *
 * Each field is copied by name on purpose. `technicalDetails` is a **subdocument array**, so these
 * are Mongoose documents, not plain objects: spreading one copies its internals and none of its
 * fields, and the panel renders a row with no label, no value and nothing to change. The types say
 * plain object, which is exactly why this is worth stating — the type is not what arrives.
 */
export type TechnicalDetailView = TechnicalDetail & {
  /** The usual answers, for the screen to offer. Derived per response, never stored. */
  options: string[];
};

function withOptions(details: TechnicalDetail[]): TechnicalDetailView[] {
  const options: Record<string, string[]> = TECHNICAL_FIELD_OPTIONS;
  return details.map((detail) => ({
    field: detail.field,
    label: detail.label,
    value: detail.value,
    source: detail.source,
    required: detail.required,
    question: detail.question,
    options: options[detail.field] ?? [],
  }));
}

export class DraftResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty({ enum: DraftStatus }) status!: DraftStatus;

  /** Whether this is the product's first plan or a later change to it. */
  @ApiProperty({ enum: DraftKind }) kind!: DraftKind;

  /** Position in the project's planning history: 0 is the initial plan, 1 the first enhancement. */
  @ApiProperty() seq!: number;

  /** The enhancement's name; null for the initial plan. */
  @ApiProperty({ nullable: true }) title!: string | null;

  /** What to call this plan on screen: "Initial plan", or "ENH-001 — Implement Dark Mode". */
  @ApiProperty() label!: string;
  @ApiProperty({ type: 'array', items: { type: 'object' } }) clarifications!: Clarification[];

  /**
   * The product's technical decisions, each with where its value came from, so the screen can say
   * "Detected from Requirement" rather than presenting a guess as a fact.
   */
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  technicalDetails!: TechnicalDetailView[];

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description:
      'Credentials the generated application needs at runtime. Carries each name, its purpose and whether a value has been stored — **never the value**.',
  })
  requiredSecrets!: RequiredSecret[];
  @ApiProperty({ nullable: true }) planMarkdown!: string | null;
  @ApiProperty() planApproved!: boolean;
  @ApiProperty({ nullable: true }) planFeedback!: string | null;
  @ApiProperty({ type: [String] }) planIssues!: string[];
  @ApiProperty({ nullable: true }) runNote!: string | null;
  @ApiProperty({ type: 'array', items: { type: 'object' } }) backlog!: BacklogItem[];
  @ApiProperty() backlogApproved!: boolean;
  @ApiProperty({ type: ApprovalStateDto }) approval!: ApprovalStateDto;
  @ApiProperty({ nullable: true }) currentRunId!: string | null;

  static fromDocument(doc: DraftDocument): DraftResponseDto {
    const a = doc.approval;
    return {
      id: doc.id,
      projectId: doc.projectId.toString(),
      status: doc.status,
      kind: doc.kind,
      seq: doc.seq,
      title: doc.title ?? null,
      label: draftLabel(doc),
      clarifications: doc.clarifications,
      technicalDetails: withOptions(doc.technicalDetails ?? []),
      requiredSecrets: doc.requiredSecrets,
      planMarkdown: doc.planMarkdown,
      planApproved: doc.planApproved,
      planFeedback: doc.planFeedback,
      planIssues: doc.planIssues ?? [],
      runNote: doc.runNote ?? null,
      backlog: doc.backlog,
      backlogApproved: doc.backlogApproved,
      approval: {
        approved: a.approved,
        approvedBy: a.approvedBy,
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        adoTargetConfirmed: a.adoTargetConfirmed,
        confirmedTarget: a.confirmedTarget
          ? {
              orgUrl: a.confirmedTarget.orgUrl,
              project: a.confirmedTarget.project,
              areaPath: a.confirmedTarget.areaPath,
            }
          : null,
        confirmedBy: a.confirmedBy,
        confirmedAt: a.confirmedAt ? a.confirmedAt.toISOString() : null,
        pushedToAdo: a.pushedToAdo,
        pushedAt: a.pushedAt ? a.pushedAt.toISOString() : null,
      },
      currentRunId: doc.currentRunId,
    };
  }
}

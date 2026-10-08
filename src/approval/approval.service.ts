import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { findActiveDraft } from '../planning/draft-repository';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Draft, DraftDocument, DraftStatus } from '../planning/schemas/draft.schema';
import { validateBacklog } from '../planning/backlog-validation';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ConfirmAdoTargetDto } from './dto/confirm-ado-target.dto';

/**
 * The approval + ADO-target-confirmation gate (WORKFLOW.md §4). Two deliberate steps must both
 * complete before any Azure DevOps write: (1) the admin approves the draft (plan approved, backlog
 * valid), and (2) the admin re-confirms the org/project/area path. {@link assertWritable} is the
 * single choke point every ADO write calls first. Every gate transition is audited.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
    private readonly audit: AuditService,
  ) {}

  private async getDraft(projectId: string): Promise<DraftDocument> {
    const draft = await findActiveDraft(this.draftModel, projectId);
    if (!draft) {
      throw new NotFoundException('No planning draft for this project.');
    }
    return draft;
  }

  /** Step 1 — approve the draft. Requires an approved plan and a validation-clean, non-empty backlog. */
  async approve(projectId: string, user: AuthenticatedUser): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    if (!draft.planApproved) {
      throw new BadRequestException('Approve the plan before approving the draft.');
    }
    if (draft.backlog.length === 0) {
      throw new BadRequestException('The backlog is empty; nothing to approve.');
    }
    const errors = validateBacklog(draft.backlog, {
      planMarkdown: draft.planMarkdown,
    }).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new BadRequestException(
        `Resolve ${errors.length} backlog validation error(s) before approving.`,
      );
    }
    draft.backlogApproved = true;
    draft.approval.approved = true;
    draft.approval.approvedBy = user.email;
    draft.approval.approvedAt = new Date();
    draft.status = DraftStatus.Approved;
    const saved = await draft.save();
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.DraftApproved,
      entityType: 'draft',
      entityId: saved.id,
      projectId,
      metadata: { backlogItems: draft.backlog.length },
    });
    return saved;
  }

  /** Step 2 — re-confirm the ADO target. Requires the draft to be approved first. */
  async confirmAdoTarget(
    projectId: string,
    dto: ConfirmAdoTargetDto,
    user: AuthenticatedUser,
  ): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    if (!draft.approval.approved) {
      throw new BadRequestException('Approve the draft before confirming the ADO target.');
    }
    draft.approval.confirmedTarget = {
      orgUrl: dto.orgUrl,
      project: dto.project,
      areaPath: dto.areaPath,
    };
    draft.approval.adoTargetConfirmed = true;
    draft.approval.confirmedBy = user.email;
    draft.approval.confirmedAt = new Date();
    const saved = await draft.save();
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.AdoTargetConfirmed,
      entityType: 'draft',
      entityId: saved.id,
      projectId,
      metadata: { orgUrl: dto.orgUrl, project: dto.project, areaPath: dto.areaPath },
    });
    return saved;
  }

  /**
   * The pre-write guard. Throws unless the draft is approved AND the ADO target is confirmed.
   * Every ADO write must call this first — it is the enforcement point for "no write without
   * explicit approval + confirmation".
   */
  static assertWritable(draft: DraftDocument): void {
    if (!draft.approval.approved) {
      throw new BadRequestException('Draft is not approved; ADO writes are blocked.');
    }
    if (!draft.approval.adoTargetConfirmed || !draft.approval.confirmedTarget) {
      throw new BadRequestException('ADO target is not confirmed; ADO writes are blocked.');
    }
  }
}

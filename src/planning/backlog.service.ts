import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { findActiveDraft } from './draft-repository';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { BlobService } from '../common/storage/blob.service';
import { Draft, DraftDocument, BacklogItem } from './schemas/draft.schema';
import { CreateBacklogItemDto, MoveBacklogItemDto, UpdateBacklogItemDto } from './dto/backlog.dto';
import { validateBacklog, ValidationIssue } from './backlog-validation';
import { UploadedFile } from '../requirements/requirements.service';

/**
 * Edits the draft backlog held in MongoDB (add/edit/delete/reorder/re-parent, dependencies,
 * priority, per-task repo/sprint, attachments) and validates it. All edits persist to the draft;
 * nothing reaches Azure DevOps until approval.
 */
@Injectable()
export class BacklogService {
  constructor(
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
    private readonly blob: BlobService,
  ) {}

  private async getDraft(projectId: string): Promise<DraftDocument> {
    const draft = await findActiveDraft(this.draftModel, projectId);
    if (!draft) {
      throw new NotFoundException('No planning draft for this project.');
    }
    return draft;
  }

  private item(draft: DraftDocument, itemId: string): BacklogItem {
    const found = draft.backlog.find((i) => i.id === itemId);
    if (!found) {
      throw new NotFoundException('Backlog item not found.');
    }
    return found;
  }

  /** Ordinal at the end of a parent's sibling list. */
  private nextOrder(draft: DraftDocument, parentId: string | null): number {
    const siblings = draft.backlog.filter((i) => i.parentId === parentId);
    return siblings.length;
  }

  async add(projectId: string, dto: CreateBacklogItemDto): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    const parentId = dto.parentId ?? null;
    if (parentId && !draft.backlog.some((i) => i.id === parentId)) {
      throw new BadRequestException('Parent item does not exist.');
    }
    draft.backlog.push({
      id: randomUUID(),
      type: dto.type,
      title: dto.title,
      description: dto.description ?? '',
      acceptanceCriteria: dto.acceptanceCriteria ?? '',
      parentId,
      order: this.nextOrder(draft, parentId),
      priority: dto.priority ?? 2,
      estimate: null,
      dependsOn: [],
      repo: dto.repo ?? null,
      sprint: dto.sprint ?? null,
      attachments: [],
      adoId: null,
    });
    return draft.save();
  }

  async update(
    projectId: string,
    itemId: string,
    dto: UpdateBacklogItemDto,
  ): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    const item = this.item(draft, itemId);
    Object.assign(item, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.acceptanceCriteria !== undefined && { acceptanceCriteria: dto.acceptanceCriteria }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.repo !== undefined && { repo: dto.repo }),
      ...(dto.sprint !== undefined && { sprint: dto.sprint }),
      ...(dto.order !== undefined && { order: dto.order }),
      ...(dto.dependsOn !== undefined && { dependsOn: dto.dependsOn }),
    });
    return draft.save();
  }

  async remove(projectId: string, itemId: string): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    const target = this.item(draft, itemId);
    // Re-parent direct children to the removed item's parent (no orphans).
    for (const child of draft.backlog) {
      if (child.parentId === itemId) {
        child.parentId = target.parentId;
      }
    }
    draft.backlog = draft.backlog.filter((i) => i.id !== itemId);
    // Drop dangling dependencies on the removed item.
    for (const i of draft.backlog) {
      i.dependsOn = i.dependsOn.filter((d) => d !== itemId);
    }
    return draft.save();
  }

  /** True if `candidateAncestorId` is `itemId` or one of its descendants (re-parent cycle guard). */
  private isSelfOrDescendant(
    draft: DraftDocument,
    itemId: string,
    candidateAncestorId: string,
  ): boolean {
    if (itemId === candidateAncestorId) return true;
    const children = draft.backlog.filter((i) => i.parentId === itemId);
    return children.some((c) => this.isSelfOrDescendant(draft, c.id, candidateAncestorId));
  }

  /** Re-parents and reorders an item (Kanban move), rejecting moves that would create a cycle. */
  async move(projectId: string, itemId: string, dto: MoveBacklogItemDto): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    const item = this.item(draft, itemId);
    const newParentId = dto.parentId ?? null;
    if (newParentId) {
      if (!draft.backlog.some((i) => i.id === newParentId)) {
        throw new BadRequestException('Target parent does not exist.');
      }
      if (this.isSelfOrDescendant(draft, itemId, newParentId)) {
        throw new BadRequestException('Cannot move an item under itself or its descendant.');
      }
    }
    item.parentId = newParentId;
    item.order = dto.order;
    return draft.save();
  }

  /** Uploads an attachment to an item (bytes to Blob, metadata on the draft). */
  async addAttachment(
    projectId: string,
    itemId: string,
    file: UploadedFile,
  ): Promise<DraftDocument> {
    const draft = await this.getDraft(projectId);
    const item = this.item(draft, itemId);
    const stored = await this.blob.upload(`backlog/${projectId}/${itemId}`, file);
    item.attachments.push({
      originalName: stored.originalName,
      url: stored.url,
      contentType: stored.contentType,
      size: stored.size,
    });
    return draft.save();
  }

  /** Validates the current draft backlog. */
  async validate(projectId: string): Promise<ValidationIssue[]> {
    const draft = await this.getDraft(projectId);
    return validateBacklog(draft.backlog, { planMarkdown: draft.planMarkdown });
  }
}

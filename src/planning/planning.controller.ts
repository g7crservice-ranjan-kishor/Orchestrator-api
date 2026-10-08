import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlanningService } from './planning.service';
import { BacklogService } from './backlog.service';
import { DraftResponseDto } from './dto/draft-response.dto';
import { AnswerClarificationDto } from './dto/answer-clarification.dto';
import { RegeneratePlanDto } from './dto/regenerate-plan.dto';
import { StartEnhancementDto } from './dto/start-enhancement.dto';
import { SetTechnicalDetailDto } from './dto/technical-detail.dto';
import { SetRequiredSecretDto } from './dto/required-secrets.dto';
import { CreateBacklogItemDto, MoveBacklogItemDto, UpdateBacklogItemDto } from './dto/backlog.dto';
import { ValidationIssue } from './backlog-validation';
import type { UploadedFile as UploadedFileType } from '../requirements/requirements.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { DraftDocument } from './schemas/draft.schema';

/** Admin-facing planning + backlog-editing API (session-authenticated via the global guard). */
@ApiTags('planning')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly backlog: BacklogService,
    private readonly audit: AuditService,
  ) {}

  /** Records a planning/backlog action against the draft, then returns the projection. */
  private async recordAndReturn(
    doc: DraftDocument,
    projectId: string,
    user: AuthenticatedUser,
    action: AuditAction,
    metadata: Record<string, unknown> = {},
  ): Promise<DraftResponseDto> {
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action,
      entityType: 'draft',
      entityId: doc.id,
      projectId,
      metadata,
    });
    return DraftResponseDto.fromDocument(doc);
  }

  @Get('draft')
  @ApiOperation({ summary: 'Get the planning draft for a project.' })
  @ApiOkResponse({ type: DraftResponseDto })
  async draft(@Param('projectId') projectId: string): Promise<DraftResponseDto> {
    return DraftResponseDto.fromDocument(await this.planning.getOrCreateDraft(projectId));
  }

  @Post('planning/em')
  @ApiOperation({ summary: 'Start the EM planning session.' })
  async startEm(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.startEmPlanning(projectId);
    return this.recordAndReturn(doc, projectId, user, AuditAction.EmPlanningStarted);
  }

  @Post('technical-details/refresh')
  @ApiOperation({
    summary: 'Re-read the technical decisions from the requirement and the project.',
    description:
      'Resolves each detail in order: what the requirement says, then what the project already ' +
      'decided, then nothing — which becomes a question. Answers a person gave are left alone.',
  })
  @ApiOkResponse({ type: DraftResponseDto })
  async refreshTechnicalDetails(@Param('projectId') projectId: string): Promise<DraftResponseDto> {
    return DraftResponseDto.fromDocument(await this.planning.refreshTechnicalDetails(projectId));
  }

  @Post('technical-details/:field')
  @ApiOperation({ summary: 'Answer one technical detail.' })
  @ApiOkResponse({ type: DraftResponseDto })
  async setTechnicalDetail(
    @Param('projectId') projectId: string,
    @Param('field') field: string,
    @Body() dto: SetTechnicalDetailDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.setTechnicalDetail(projectId, field, dto.value);
    return this.recordAndReturn(doc, projectId, user, AuditAction.ClarificationAnswered);
  }

  @Post('planning/enhancement')
  @ApiOperation({
    summary: 'Start a new planning cycle on a product that is already built.',
    description:
      'Creates a separate draft (ENH-001, ENH-002, …) and starts the EM session against it. The ' +
      'existing plan and its Azure DevOps work items are left exactly as they are.',
  })
  @ApiOkResponse({ type: DraftResponseDto })
  async startEnhancement(
    @Param('projectId') projectId: string,
    @Body() dto: StartEnhancementDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.startEnhancement(projectId, {
      title: dto.title,
      requirementId: dto.requirementId ?? null,
      sprintAnchor: dto.sprintAnchor,
    });
    return this.recordAndReturn(doc, projectId, user, AuditAction.EmPlanningStarted);
  }

  @Post('clarifications/:clarificationId/answer')
  @ApiOperation({ summary: 'Answer an EM clarification.' })
  async answer(
    @Param('projectId') projectId: string,
    @Param('clarificationId') clarificationId: string,
    @Body() dto: AnswerClarificationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.answerClarification(projectId, clarificationId, dto.answer);
    return this.recordAndReturn(doc, projectId, user, AuditAction.ClarificationAnswered, {
      clarificationId,
    });
  }

  @Post('required-secrets/:name')
  @ApiOperation({
    summary:
      "Supply one of the application's runtime credentials. The value goes straight to Key Vault — it is never stored in MongoDB and no endpoint returns it.",
  })
  async setRequiredSecret(
    @Param('projectId') projectId: string,
    @Param('name') name: string,
    @Body() dto: SetRequiredSecretDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const draft = await this.planning.setRequiredSecret(projectId, name, dto.value);
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.AppSecretProvided,
      entityType: 'project',
      entityId: projectId,
      projectId,
      // The name is recorded so the trail shows *which* credential was set — never the value.
      metadata: { secret: name.trim().toUpperCase() },
    });
    return DraftResponseDto.fromDocument(draft);
  }

  @Post('plan/approve')
  @ApiOperation({ summary: 'Approve the plan (gate before backlog drafting).' })
  async approvePlan(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.approvePlan(projectId);
    return this.recordAndReturn(doc, projectId, user, AuditAction.PlanApproved);
  }

  @Post('plan/regenerate')
  @ApiOperation({ summary: 'Request changes: re-run the EM planning session with feedback.' })
  async regenerate(
    @Param('projectId') projectId: string,
    @Body() dto: RegeneratePlanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.regeneratePlan(projectId, dto.feedback);
    return this.recordAndReturn(doc, projectId, user, AuditAction.PlanRegenerated, {
      hasFeedback: Boolean(dto.feedback?.trim()),
    });
  }

  @Post('planning/sm')
  @ApiOperation({ summary: 'Start the SM backlog-drafting session (requires approved plan).' })
  async startSm(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.planning.startSmBacklog(projectId);
    return this.recordAndReturn(doc, projectId, user, AuditAction.SmBacklogStarted);
  }

  // --- Backlog editor -------------------------------------------------------
  @Post('backlog/items')
  @ApiOperation({ summary: 'Add a backlog item.' })
  async addItem(
    @Param('projectId') projectId: string,
    @Body() dto: CreateBacklogItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.backlog.add(projectId, dto);
    return this.recordAndReturn(doc, projectId, user, AuditAction.BacklogEdited, { op: 'add' });
  }

  @Patch('backlog/items/:itemId')
  @ApiOperation({ summary: 'Edit a backlog item (title/desc/priority/repo/sprint/deps/order).' })
  async updateItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateBacklogItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.backlog.update(projectId, itemId, dto);
    return this.recordAndReturn(doc, projectId, user, AuditAction.BacklogEdited, {
      op: 'update',
      itemId,
    });
  }

  @Delete('backlog/items/:itemId')
  @ApiOperation({ summary: 'Delete a backlog item (children re-parent to its parent).' })
  async deleteItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.backlog.remove(projectId, itemId);
    return this.recordAndReturn(doc, projectId, user, AuditAction.BacklogEdited, {
      op: 'delete',
      itemId,
    });
  }

  @Post('backlog/items/:itemId/move')
  @ApiOperation({ summary: 'Re-parent + reorder a backlog item (Kanban move).' })
  async moveItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: MoveBacklogItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    const doc = await this.backlog.move(projectId, itemId, dto);
    return this.recordAndReturn(doc, projectId, user, AuditAction.BacklogEdited, {
      op: 'move',
      itemId,
    });
  }

  @Post('backlog/items/:itemId/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Attach a document to a backlog item.' })
  async addAttachment(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @UploadedFile() file: UploadedFileType | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    if (!file) {
      throw new BadRequestException('A file is required (multipart field "file").');
    }
    const doc = await this.backlog.addAttachment(projectId, itemId, file);
    return this.recordAndReturn(doc, projectId, user, AuditAction.BacklogEdited, {
      op: 'attachment',
      itemId,
    });
  }

  @Get('backlog/validation')
  @ApiOperation({ summary: 'Validate the draft backlog.' })
  async validate(@Param('projectId') projectId: string): Promise<ValidationIssue[]> {
    return this.backlog.validate(projectId);
  }
}

import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DevelopmentService } from './development.service';
import { TaskTransitionService } from './task-transition.service';
import { StartDevelopmentDto } from './dto/start-development.dto';
import { TransitionTasksDto } from './dto/transition-tasks.dto';
import { TaskTransitionResponseDto } from './dto/task-transition-response.dto';
import { BatchDispatchResponseDto } from './dto/batch-dispatch-response.dto';
import { RunResponseDto } from '../runs/dto/run-response.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/**
 * Admin-facing Developer-dispatch API (session-authenticated via the global JWT guard). Starting
 * development on an approved Task dispatches one Developer pod (ARCHITECTURE.md §4A); the run is
 * then observable through the run monitor (`GET /runs/:id`, WS relay).
 */
@ApiTags('development')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/development')
export class DevelopmentController {
  constructor(
    private readonly development: DevelopmentService,
    private readonly transitions: TaskTransitionService,
    private readonly audit: AuditService,
  ) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a Developer run for one approved ADO Task (one AKS pod per Task).',
  })
  @ApiCreatedResponse({ type: RunResponseDto })
  async start(
    @Param('projectId') projectId: string,
    @Body() dto: StartDevelopmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RunResponseDto> {
    const job = await this.development.startDevelopment(projectId, {
      workItemId: dto.workItemId,
      repo: dto.repo,
    });
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.DevelopmentStarted,
      entityType: 'run',
      entityId: job.runId,
      projectId,
      metadata: { workItemId: dto.workItemId, repo: dto.repo },
    });
    return RunResponseDto.fromDocument(job);
  }

  @Post('transition')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Transition Task(s) on the Development board: Draft → To Do (approve) or To Do → In Progress (dispatch the Developer Agent). Single or bulk; every operation is audited. Done is orchestrator-owned and rejected.',
  })
  @ApiOkResponse({ type: TaskTransitionResponseDto })
  async transition(
    @Param('projectId') projectId: string,
    @Body() dto: TransitionTasksDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskTransitionResponseDto> {
    return this.transitions.transition(projectId, dto.taskKeys, dto.to, user, {
      dryRun: dto.dryRun,
      source: dto.source,
    });
  }

  @Post('start-batch')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Start Development for every eligible To Do Task in the project (one pod per Task; idempotent).',
  })
  @ApiCreatedResponse({ type: BatchDispatchResponseDto })
  async startBatch(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDispatchResponseDto> {
    const result = await this.development.startDevelopmentBatch(projectId);
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.DevelopmentBatchStarted,
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: {
        candidates: result.candidates,
        dispatched: result.dispatched.map((j) => j.runId),
        skippedActive: result.skippedActive.length,
        ineligible: result.ineligible.length,
        deferred: result.deferred.length,
      },
    });
    return BatchDispatchResponseDto.fromResult(result);
  }
}

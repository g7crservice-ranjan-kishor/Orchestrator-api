import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { QaQueueService, QaQueueView } from './qa-queue.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

/** The Stories a person selected, in the order they should be tested. */
export class EnqueueStoriesDto {
  @ApiProperty({ type: [String], example: ['413', '414', '415'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  workItemIds!: string[];
}

/**
 * The QA queue: an ordered selection of Stories drained one run at a time.
 *
 * Read back from the server rather than held in the browser, so a refresh shows the same order and
 * the board can be opened elsewhere mid-batch and still show what is under test.
 */
@ApiTags('qa')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/qa-queue')
export class QaQueueController {
  constructor(
    private readonly queue: QaQueueService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The current QA queue for a project.' })
  @ApiOkResponse({ description: 'Testing, queued, completed and failed Stories, in order.' })
  view(@Param('projectId') projectId: string): Promise<QaQueueView> {
    return this.queue.view(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue selected Stories for QA; the first starts immediately if a slot is free.',
  })
  async enqueue(
    @Param('projectId') projectId: string,
    @Body() dto: EnqueueStoriesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QaQueueView> {
    const view = await this.queue.enqueue(projectId, dto.workItemIds, user);
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.QaBatchStarted,
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: {
        via: 'qa-queue',
        batchId: view.batchId,
        queued: dto.workItemIds.length,
        order: dto.workItemIds,
      },
    });
    return view;
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a queue a failure halted; the failed Story is retried first.' })
  resume(@Param('projectId') projectId: string): Promise<QaQueueView> {
    return this.queue.resume(projectId);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Drop everything still waiting; a run in flight is left alone.' })
  cancel(@Param('projectId') projectId: string): Promise<QaQueueView> {
    return this.queue.cancel(projectId);
  }
}

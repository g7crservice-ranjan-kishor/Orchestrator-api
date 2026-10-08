import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DevQueueService, DevQueueView } from './dev-queue.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

/** The Tasks a person selected, in the order they should run. */
export class EnqueueTasksDto {
  @ApiProperty({ type: [String], example: ['201', '202', '203'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  workItemIds!: string[];
}

/**
 * The development queue: an ordered selection drained one run at a time.
 *
 * Read back rather than held in the browser, so a refresh shows the same order, and so the board
 * can be opened on another machine mid-batch and still show what is running.
 */
@ApiTags('development')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/development-queue')
export class DevQueueController {
  constructor(
    private readonly queue: DevQueueService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The current development queue for a project.' })
  @ApiOkResponse({ description: 'Running, queued, completed and failed Tasks, in order.' })
  view(@Param('projectId') projectId: string): Promise<DevQueueView> {
    return this.queue.view(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue selected Tasks; the first starts immediately if a slot is free.',
  })
  async enqueue(
    @Param('projectId') projectId: string,
    @Body() dto: EnqueueTasksDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DevQueueView> {
    const view = await this.queue.enqueue(projectId, dto.workItemIds, user);
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.TaskDevelopmentStarted,
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: {
        via: 'development-queue',
        batchId: view.batchId,
        queued: dto.workItemIds.length,
        order: dto.workItemIds,
      },
    });
    return view;
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a queue a failed run halted.' })
  resume(@Param('projectId') projectId: string): Promise<DevQueueView> {
    return this.queue.resume(projectId);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Drop everything still waiting; a run in flight is left alone.' })
  cancel(@Param('projectId') projectId: string): Promise<DevQueueView> {
    return this.queue.cancel(projectId);
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { QaService } from './qa.service';
import { QaTestTabService } from './qa-test-tab.service';
import { QaBoard, QaBoardService } from './qa-board.service';
import { QaBatchResponseDto } from './dto/qa-batch-response.dto';
import { StoryTestsResponseDto } from './dto/story-tests-response.dto';
import { StartQaDto } from './dto/start-qa.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/**
 * Admin-facing QA-dispatch API (session-authenticated via the global JWT guard). A single
 * **Start QA** click enqueues a batch: the backend enumerates every Story in Done (Ready for QA)
 * and every Bug awaiting retest under the project's area path and fans out one isolated QA pod per
 * item (ARCHITECTURE.md §4B, D-018). QA is human-triggered — there is no auto-dispatch on Story
 * Done. Re-clicking is idempotent (the one-active-run guard never double-dispatches an item under
 * test); repeated clicks drive the bug loop forward as Stories return to Done and Bugs are fixed.
 */
@ApiTags('qa')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/qa')
export class QaController {
  constructor(
    private readonly qa: QaService,
    private readonly testTab: QaTestTabService,
    private readonly qaBoard: QaBoardService,
    private readonly audit: AuditService,
  ) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Start QA for every Ready-for-QA item in the project (one pod per Story in Done / Bug awaiting retest; idempotent).',
  })
  @ApiCreatedResponse({ type: QaBatchResponseDto })
  async start(
    @Param('projectId') projectId: string,
    @Body() dto: StartQaDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QaBatchResponseDto> {
    const result = await this.qa.startQaBatch(projectId, {
      dryRun: dto.dryRun,
      workItemIds: dto.workItemIds,
    });
    // A preview dispatches nothing, so it is not an auditable event.
    if (result.dryRun) {
      return QaBatchResponseDto.fromResult(result);
    }
    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.QaBatchStarted,
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: {
        candidates: result.candidates,
        dispatched: result.dispatched.map((d) => d.runId),
        skippedActive: result.skippedActive.length,
        ineligible: result.ineligible.length,
        deferred: result.deferred.length,
      },
    });
    return QaBatchResponseDto.fromResult(result);
  }

  @Get('board')
  @ApiOperation({
    summary:
      'Story-level QA view: every Story that is ready for QA, under test, failed, or passed — with its hierarchy, Task progress and latest QA run.',
  })
  async board(@Param('projectId') projectId: string): Promise<QaBoard> {
    return this.qaBoard.getQaBoard(projectId);
  }

  @Get('stories/:storyId/tests')
  @ApiOperation({
    summary:
      "A Story's Test Cases + latest test-point outcomes for the Test tab (read-only, one-directional).",
  })
  @ApiOkResponse({ type: StoryTestsResponseDto })
  async storyTests(
    @Param('projectId') projectId: string,
    @Param('storyId') storyId: string,
  ): Promise<StoryTestsResponseDto> {
    const tests = await this.testTab.getStoryTests(projectId, storyId);
    return StoryTestsResponseDto.fromStoryTests(tests);
  }
}

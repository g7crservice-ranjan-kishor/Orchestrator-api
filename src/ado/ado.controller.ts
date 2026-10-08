import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdoPushService, PushResult } from './ado-push.service';
import { AdoBoardService, Board } from './ado-board.service';
import { SprintRolloverPlan, SprintRolloverService } from './sprint-rollover.service';
import { CompleteSprintDto } from './dto/complete-sprint.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/** Authoritative ADO write (push) + read-only board projection for a project. */
@ApiTags('ado')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId')
export class AdoController {
  constructor(
    private readonly push: AdoPushService,
    private readonly board: AdoBoardService,
    private readonly rollover: SprintRolloverService,
  ) {}

  @Post('ado/push')
  @ApiOperation({ summary: 'Create the approved backlog in Azure DevOps (idempotent).' })
  async pushToAdo(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PushResult> {
    return this.push.push(projectId, user);
  }

  @Get('board')
  @ApiOperation({ summary: 'Board view of the created ADO items (read-only, one-directional).' })
  async getBoard(@Param('projectId') projectId: string): Promise<Board> {
    return this.board.getBoard(projectId);
  }

  @Post('board/sprint/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Close the active sprint and start the next one by moving their iteration dates in Azure DevOps. `dryRun` previews the new dates, the carry-over Tasks and any blockers without changing anything.',
  })
  async completeSprint(
    @Param('projectId') projectId: string,
    @Body() dto: CompleteSprintDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SprintRolloverPlan> {
    return this.rollover.completeCurrentSprint(projectId, user, { dryRun: dto.dryRun });
  }
}

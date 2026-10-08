import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Param } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ConfirmAdoTargetDto } from './dto/confirm-ado-target.dto';
import { DraftResponseDto } from '../planning/dto/draft-response.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/** The approval gate: approve the draft, then re-confirm the ADO target (both required before push). */
@ApiTags('approval')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId')
export class ApprovalController {
  constructor(private readonly approval: ApprovalService) {}

  @Post('approve')
  @ApiOperation({ summary: 'Approve the draft (plan approved + backlog valid).' })
  async approve(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    return DraftResponseDto.fromDocument(await this.approval.approve(projectId, user));
  }

  @Post('confirm-ado-target')
  @ApiOperation({ summary: 'Re-confirm the ADO org/project/area path before any write.' })
  async confirm(
    @Param('projectId') projectId: string,
    @Body() dto: ConfirmAdoTargetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DraftResponseDto> {
    return DraftResponseDto.fromDocument(
      await this.approval.confirmAdoTarget(projectId, dto, user),
    );
  }
}

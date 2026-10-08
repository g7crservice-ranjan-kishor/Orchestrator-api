import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrchestrationService } from './orchestration.service';
import { OrchestrationStatusDto } from './dto/orchestration-status.dto';

/**
 * Read-only observability for the orchestration scheduler (Phase 2.1). Session-authenticated via the
 * global JWT guard. Reports the enabled state, interval, active roles, concurrency, last tick time,
 * and the last wave's tallies so an admin can see what the autonomous loop is doing.
 */
@ApiTags('orchestration')
@ApiBearerAuth('access-token')
@Controller('orchestration')
export class OrchestrationController {
  constructor(private readonly orchestration: OrchestrationService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Orchestration scheduler status (enabled, roles, activeRuns, last tick).',
  })
  @ApiOkResponse({ type: OrchestrationStatusDto })
  async status(): Promise<OrchestrationStatusDto> {
    return this.orchestration.getStatus();
  }
}

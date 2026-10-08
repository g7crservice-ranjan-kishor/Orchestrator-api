import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RunTokenGuard } from '../common/security/run-token.guard';
import { RunsService } from './runs.service';
import { RunEventDto } from './dto/run-event.dto';

/**
 * Privileged Runner API: the Agent Runner pod POSTs run events here. Authenticated by the per-run
 * token ({@link RunTokenGuard}), NOT a user session — so it is marked `@Public` to bypass the
 * global JWT guard while the run-token guard enforces access. Private/cluster-only in deployment
 * (DEVELOPMENT_GUIDELINES §4).
 */
@ApiTags('runs')
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post(':id/events')
  @Public()
  @UseGuards(RunTokenGuard)
  @ApiSecurity('run-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest a run event from the Agent Runner (per-run token auth).' })
  async ingest(@Param('id') id: string, @Body() event: RunEventDto): Promise<{ accepted: true }> {
    await this.runs.ingest(id, event);
    return { accepted: true };
  }
}

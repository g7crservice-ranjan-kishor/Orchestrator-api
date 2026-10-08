import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobsService } from '../jobs/jobs.service';
import { RunResponseDto } from './dto/run-response.dto';

/** Session-authenticated read API for the run monitor (list a project's runs; get one run). */
@ApiTags('runs')
@ApiBearerAuth('access-token')
@Controller()
export class RunsQueryController {
  constructor(private readonly jobs: JobsService) {}

  @Get('projects/:projectId/runs')
  @ApiOperation({ summary: "List a project's runs (newest first)." })
  @ApiOkResponse({ type: RunResponseDto, isArray: true })
  async list(@Param('projectId') projectId: string): Promise<RunResponseDto[]> {
    const docs = await this.jobs.listForProject(projectId);
    return docs.map(RunResponseDto.fromDocument);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'Get a single run (state + persisted Run Result).' })
  @ApiOkResponse({ type: RunResponseDto })
  async get(@Param('id') id: string): Promise<RunResponseDto> {
    return RunResponseDto.fromDocument(await this.jobs.getByRunId(id));
  }
}

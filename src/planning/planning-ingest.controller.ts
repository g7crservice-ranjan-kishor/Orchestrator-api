import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RunTokenGuard } from '../common/security/run-token.guard';
import { PlanningService, RunContext } from './planning.service';
import { IngestBacklogDto, IngestClarificationsDto, IngestPlanDto } from './dto/ingest.dto';
import { DeclareRequiredSecretsDto } from './dto/required-secrets.dto';
import { BacklogItemType, DraftDocument } from './schemas/draft.schema';

/**
 * Privileged ingest API: the Agent Runner pod posts its planning output (clarifications / plan.md /
 * backlog.json) here, authenticated by the per-run token ({@link RunTokenGuard}). `@Public` bypasses
 * the user-session guard; the run-token guard enforces access. Private/cluster-only in deployment.
 */
@ApiTags('planning-ingest')
@Controller('runs/:id')
export class PlanningIngestController {
  constructor(private readonly planning: PlanningService) {}

  @Get('context')
  @Public()
  @UseGuards(RunTokenGuard)
  @ApiSecurity('run-token')
  @ApiOperation({
    summary: 'Agent Runner fetches grounding context (requirement + approved plan).',
  })
  async context(@Param('id') id: string): Promise<RunContext> {
    return this.planning.getRunContext(id);
  }

  @Post('clarifications')
  @Public()
  @UseGuards(RunTokenGuard)
  @ApiSecurity('run-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'EM run posts clarifying questions.' })
  async clarifications(
    @Param('id') id: string,
    @Body() dto: IngestClarificationsDto,
  ): Promise<{ accepted: true }> {
    // Either shape: a current worker sends `items` with the category and reasoning, an older
    // image sends bare strings. Both are questions; losing one to a version skew would be worse
    // than losing its category.
    const items = dto.items ?? (dto.questions ?? []).map((question) => ({ question }));
    await this.planning.ingestClarifications(id, items);
    return { accepted: true };
  }

  @Post('required-secrets')
  @Public()
  @UseGuards(RunTokenGuard)
  @ApiSecurity('run-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'EM run declares the credentials the generated application will need at runtime (names and purpose only — never values).',
  })
  async requiredSecrets(
    @Param('id') id: string,
    @Body() dto: DeclareRequiredSecretsDto,
  ): Promise<{ accepted: true }> {
    await this.planning.declareRequiredSecretsForRun(id, dto.secrets);
    return { accepted: true };
  }

  @Post('plan')
  @Public()
  @UseGuards(RunTokenGuard)
  @ApiSecurity('run-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'EM run posts the plan.md content.' })
  async plan(@Param('id') id: string, @Body() dto: IngestPlanDto): Promise<{ accepted: true }> {
    await this.planning.ingestPlan(id, dto.markdown);
    return { accepted: true };
  }

  @Post('backlog')
  @Public()
  @UseGuards(RunTokenGuard)
  @ApiSecurity('run-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'SM run posts the backlog.json content.' })
  async backlog(
    @Param('id') id: string,
    @Body() dto: IngestBacklogDto,
  ): Promise<{ accepted: true }> {
    await this.planning.ingestBacklog(
      id,
      // A field the agent did not mention is left **undefined**, not blanked: on a correction
      // the merge reads absence as "keep what is there", and `?? ''` would erase it instead.
      dto.items.map((i) => ({
        id: i.id,
        ...(i.type !== undefined ? { type: i.type as BacklogItemType } : {}),
        ...(i.title !== undefined ? { title: i.title } : {}),
        ...(i.description !== undefined ? { description: i.description } : {}),
        ...(i.acceptanceCriteria !== undefined ? { acceptanceCriteria: i.acceptanceCriteria } : {}),
        ...(i.parentId !== undefined ? { parentId: i.parentId } : {}),
        ...(i.repo !== undefined ? { repo: i.repo } : {}),
        ...(i.sprint !== undefined ? { sprint: i.sprint } : {}),
        // Carried through like every other field the agent sets. Hardcoding `[]` here discarded
        // it silently: the Scrum Master could be told to declare dependencies, could declare
        // them, and every item still arrived with none — so nothing could check the ordering
        // they described.
        ...(i.dependsOn !== undefined ? { dependsOn: i.dependsOn } : {}),
        order: 0,
        priority: 2,
        estimate: null,
        attachments: [],
        adoId: null,
      })) as DraftDocument['backlog'],
    );
    return { accepted: true };
  }
}

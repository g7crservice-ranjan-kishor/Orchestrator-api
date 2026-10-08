import { Module } from '@nestjs/common';
import { KnowledgeBaseModule } from '../knowledge/knowledge-base.module';
import { MongooseModule } from '@nestjs/mongoose';
import { PlanningService } from './planning.service';
import { BacklogService } from './backlog.service';
import { PlanningController } from './planning.controller';
import { PlanningIngestController } from './planning-ingest.controller';
import { Draft, DraftSchema } from './schemas/draft.schema';
import { ProjectsModule } from '../projects/projects.module';
import { RequirementsModule } from '../requirements/requirements.module';
import { JobsModule } from '../jobs/jobs.module';
import { AuditModule } from '../audit/audit.module';
import { AdoModule } from '../ado/ado.module';

/**
 * Planning pipeline: EM/SM dispatch, plan/backlog ingest, clarification thread, backlog editor +
 * validation. Drafts persist in MongoDB with no ADO side effects until approval.
 */
@Module({
  imports: [
    KnowledgeBaseModule,
    MongooseModule.forFeature([{ name: Draft.name, schema: DraftSchema }]),
    ProjectsModule,
    RequirementsModule,
    JobsModule,
    AuditModule,
    AdoModule,
  ],
  controllers: [PlanningController, PlanningIngestController],
  providers: [PlanningService, BacklogService],
  exports: [PlanningService, BacklogService],
})
export class PlanningModule {}

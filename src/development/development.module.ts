import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DevelopmentService } from './development.service';
import { TaskTransitionService } from './task-transition.service';
import { StoryRollupService } from './story-rollup.service';
import { DevelopmentController } from './development.controller';
import { ProjectsModule } from '../projects/projects.module';
import { JobsModule } from '../jobs/jobs.module';
import { AuditModule } from '../audit/audit.module';
import { AdoModule } from '../ado/ado.module';
import { Draft, DraftSchema } from '../planning/schemas/draft.schema';
import { DevQueue, DevQueueSchema } from './schemas/dev-queue.schema';
import { DevQueueService } from './dev-queue.service';
import { DevQueueController } from './dev-queue.controller';

/**
 * Developer execution dispatch (Phase 2, ARCHITECTURE.md §4A). Starts one Developer pod per approved
 * ADO Task via the shared jobs table + ExecutionBackend seam, and owns the Development board's Task
 * state transitions ({@link TaskTransitionService}). Security (per-run tokens) and config come from
 * the @Global SecurityModule / AppConfigModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Draft.name, schema: DraftSchema },
      { name: DevQueue.name, schema: DevQueueSchema },
    ]),
    ProjectsModule,
    JobsModule,
    AuditModule,
    AdoModule,
  ],
  controllers: [DevelopmentController, DevQueueController],
  providers: [DevelopmentService, TaskTransitionService, StoryRollupService, DevQueueService],
  exports: [DevelopmentService, TaskTransitionService, StoryRollupService, DevQueueService],
})
export class DevelopmentModule {}

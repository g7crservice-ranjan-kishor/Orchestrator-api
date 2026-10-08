import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QaService } from './qa.service';
import { QaTestTabService } from './qa-test-tab.service';
import { QaBoardService } from './qa-board.service';
import { QaController } from './qa.controller';
import { ProjectsModule } from '../projects/projects.module';
import { JobsModule } from '../jobs/jobs.module';
import { AuditModule } from '../audit/audit.module';
import { AdoModule } from '../ado/ado.module';
import { DevelopmentModule } from '../development/development.module';
import { QA_BATCH_DISPATCHER } from '../orchestration/qa-batch.seam';
import { QaQueue, QaQueueSchema } from './schemas/qa-queue.schema';
import { QaQueueService } from './qa-queue.service';
import { QaQueueController } from './qa-queue.controller';

/**
 * QA execution dispatch (Phase 3, ARCHITECTURE.md §4B, D-018). Starts one QA pod per Ready-for-QA
 * work item via the shared jobs table + ExecutionBackend seam, mirroring the Phase-2
 * DevelopmentModule. Binds {@link QA_BATCH_DISPATCHER} to {@link QaService} so the orchestration
 * scheduler's QA leg lights up (ARCHITECTURE.md §4C) — the same service backs both the manual
 * "Start QA" endpoint and the scheduler. Imports DevelopmentModule to reuse the shared repo-tag
 * resolution statics. Security (per-run tokens) and config come from the @Global modules.
 */
@Module({
  imports: [
    ProjectsModule,
    JobsModule,
    AuditModule,
    AdoModule,
    DevelopmentModule,
    MongooseModule.forFeature([{ name: QaQueue.name, schema: QaQueueSchema }]),
  ],
  controllers: [QaController, QaQueueController],
  providers: [
    QaService,
    QaTestTabService,
    QaBoardService,
    QaQueueService,
    { provide: QA_BATCH_DISPATCHER, useExisting: QaService },
  ],
  exports: [QaService, QaQueueService, QA_BATCH_DISPATCHER],
})
export class QaModule {}

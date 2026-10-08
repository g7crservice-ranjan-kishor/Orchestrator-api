import { Module } from '@nestjs/common';
import { OrchestrationService } from './orchestration.service';
import { OrchestrationController } from './orchestration.controller';
import { JobsModule } from '../jobs/jobs.module';
import { ProjectsModule } from '../projects/projects.module';
import { DevelopmentModule } from '../development/development.module';
import { QaModule } from '../qa/qa.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Orchestration scheduler (Phase 2.1, ARCHITECTURE.md §4C). The always-on backend loop that drives
 * the Developer leg and — now that Phase 3 binds the QA seam — the QA leg, hands-off. Importing
 * {@link QaModule} makes the `QA_BATCH_DISPATCHER` provider visible so the `@Optional()` injection
 * in {@link OrchestrationService} resolves and `qaLegAvailable` becomes true (ARCHITECTURE.md §4C).
 * ScheduleModule is registered globally in AppModule (used by LeaseReclaimService too).
 */
@Module({
  imports: [JobsModule, ProjectsModule, DevelopmentModule, QaModule, AuditModule],
  controllers: [OrchestrationController],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}

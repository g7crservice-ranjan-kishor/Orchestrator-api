import { Module } from '@nestjs/common';
import { KnowledgeBaseModule } from '../knowledge/knowledge-base.module';
import { MongooseModule } from '@nestjs/mongoose';
import { AdoClientService } from './ado-client.service';
import { SprintService } from './sprint.service';
import { AdoPushService } from './ado-push.service';
import { AdoBoardService } from './ado-board.service';
import { SprintRolloverService } from './sprint-rollover.service';
import { AdoController } from './ado.controller';
import { AdoProvisioningController } from './ado-provisioning.controller';
import { AdoProvisioningService } from './ado-provisioning.service';
import { AuditModule } from '../audit/audit.module';
import { ApprovalModule } from '../approval/approval.module';
import { JobsModule } from '../jobs/jobs.module';
import { ProjectsModule } from '../projects/projects.module';
import { Draft, DraftSchema } from '../planning/schemas/draft.schema';

/**
 * Azure DevOps integration: authoritative REST writes (approved backlog → work-item hierarchy) and
 * the read-only board projection. Imports {@link ApprovalModule} for the pre-write guard,
 * {@link AuditModule} to record the push, and {@link JobsModule} so the board can reflect live QA
 * run status (the Testing column, Phase 3). Secrets/config are resolved from the global modules.
 */
@Module({
  imports: [
    KnowledgeBaseModule,
    MongooseModule.forFeature([{ name: Draft.name, schema: DraftSchema }]),
    AuditModule,
    ApprovalModule,
    JobsModule,
    ProjectsModule,
  ],
  controllers: [AdoController, AdoProvisioningController],
  providers: [
    AdoClientService,
    SprintService,
    AdoPushService,
    AdoBoardService,
    SprintRolloverService,
    AdoProvisioningService,
  ],
  exports: [
    AdoClientService,
    SprintService,
    AdoPushService,
    AdoBoardService,
    AdoProvisioningService,
  ],
})
export class AdoModule {}

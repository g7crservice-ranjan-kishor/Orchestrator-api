import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './common/config/app-config.module';
import { SecretsModule } from './common/secrets/secrets.module';
import { SecurityModule } from './common/security/security.module';
import { LoggingModule } from './common/logging/logging.module';
import { DatabaseModule } from './common/database/database.module';
import { HealthModule } from './common/health/health.module';
import { BlobModule } from './common/storage/blob.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ProjectsModule } from './projects/projects.module';
import { RequirementsModule } from './requirements/requirements.module';
import { JobsModule } from './jobs/jobs.module';
import { RunsModule } from './runs/runs.module';
import { PlanningModule } from './planning/planning.module';
import { AuditModule } from './audit/audit.module';
import { ApprovalModule } from './approval/approval.module';
import { AdoModule } from './ado/ado.module';
import { DevelopmentModule } from './development/development.module';
import { QaModule } from './qa/qa.module';
import { VerificationModule } from './verification/verification.module';
import { OrchestrationModule } from './orchestration/orchestration.module';

/**
 * Root application module. Wires the cross-cutting baseline (config, secrets, logging, database,
 * health); feature modules (auth, projects, planning, backlog, approval, ado, jobs, runs, audit)
 * are registered here as they are implemented.
 */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    SecurityModule,
    LoggingModule,
    // Global default rate limit: 100 requests / 60s per IP (auth routes tighten this).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    // Scheduler for the lease-reclaim job (retry-not-resume).
    ScheduleModule.forRoot(),
    DatabaseModule,
    BlobModule,
    HealthModule,
    UsersModule,
    AuthModule,
    ProjectsModule,
    RequirementsModule,
    JobsModule,
    RunsModule,
    PlanningModule,
    AuditModule,
    ApprovalModule,
    AdoModule,
    DevelopmentModule,
    QaModule,
    VerificationModule,
    OrchestrationModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

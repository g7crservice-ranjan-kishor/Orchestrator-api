import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProjectsModule } from '../projects/projects.module';
import { Draft, DraftSchema } from '../planning/schemas/draft.schema';
import { JobsService } from './jobs.service';
import { JobDispatchService } from './job-dispatch.service';
import { LeaseReclaimService } from './lease-reclaim.service';
import { AKSExecutionBackend } from './aks/aks-execution-backend';
import { LocalExecutionBackend } from './local/local-execution-backend';
import { EXECUTION_BACKEND } from './execution-backend';
import { Job, JobSchema } from './schemas/job.schema';

/**
 * Jobs table + lifecycle + the execution backend. The jobs collection is the record of work; the
 * active {@link ExecutionBackend} (bound to {@link EXECUTION_BACKEND}) creates one runner per run —
 * a Kubernetes Job/pod on AKS by default (container isolation + non-root bypass mode), or a local
 * child process when `EXECUTION_BACKEND=local` (single-box dev/demo). Both concrete backends are
 * also provided so either can be injected directly.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Job.name, schema: JobSchema },
      // Read-only: dispatch looks up which application credentials this project declared.
      { name: Draft.name, schema: DraftSchema },
    ]),
    ProjectsModule,
  ],
  providers: [
    JobsService,
    JobDispatchService,
    LeaseReclaimService,
    AKSExecutionBackend,
    LocalExecutionBackend,
    {
      provide: EXECUTION_BACKEND,
      inject: [AKSExecutionBackend, LocalExecutionBackend],
      useFactory: (aks: AKSExecutionBackend, local: LocalExecutionBackend) =>
        (process.env.EXECUTION_BACKEND ?? 'aks').toLowerCase() === 'local' ? local : aks,
    },
  ],
  exports: [
    JobsService,
    JobDispatchService,
    AKSExecutionBackend,
    LocalExecutionBackend,
    EXECUTION_BACKEND,
  ],
})
export class JobsModule {}

import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { ProjectsModule } from '../projects/projects.module';
import { VerificationService } from './verification.service';
import { VerificationController } from './verification.controller';

/**
 * The product verification leg: one run that starts the whole product and reports what happened.
 * It needs the jobs table and the dispatcher, and nothing else — no agent, no ADO, no prompts.
 */
@Module({
  imports: [JobsModule, ProjectsModule],
  controllers: [VerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}

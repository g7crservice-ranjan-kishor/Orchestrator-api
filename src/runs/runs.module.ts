import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { DevelopmentModule } from '../development/development.module';
import { PlanningModule } from '../planning/planning.module';
import { QaModule } from '../qa/qa.module';
import { RunsController } from './runs.controller';
import { RunsQueryController } from './runs-query.controller';
import { RunsService } from './runs.service';
import { RunsGateway } from './runs.gateway';

/**
 * Runs event ingest + live relay. The Runner API (POST /runs/:id/events) is token-authenticated;
 * the WebSocket gateway relays events to session-authenticated UI clients.
 */
@Module({
  imports: [JobsModule, AuthModule, DevelopmentModule, PlanningModule, QaModule],
  controllers: [RunsController, RunsQueryController],
  providers: [RunsService, RunsGateway],
  exports: [RunsService],
})
export class RunsModule {}

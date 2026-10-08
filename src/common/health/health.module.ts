import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { ConfigReadinessIndicator } from './config-readiness.indicator';

/** Registers the `/health` check and its dependency-readiness indicators. */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [ConfigReadinessIndicator],
})
export class HealthModule {}

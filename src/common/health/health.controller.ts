import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../auth/decorators/public.decorator';
import { ConfigReadinessIndicator } from './config-readiness.indicator';

/**
 * Liveness + dependency-readiness endpoint (DEVELOPMENT_GUIDELINES §1). `/health` aggregates a
 * Mongo ping and readiness of the Key Vault and Kubernetes integrations. It is unauthenticated so
 * orchestration probes can reach it.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongo: MongooseHealthIndicator,
    private readonly readiness: ConfigReadinessIndicator,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness and dependency readiness (Mongo, Key Vault, Kubernetes).' })
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.mongo.pingCheck('mongo'),
      () => this.readiness.keyVault(),
      () => this.readiness.kubernetes(),
    ]);
  }
}

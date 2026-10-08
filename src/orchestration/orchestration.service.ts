import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../common/config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { JobsService } from '../jobs/jobs.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { DevelopmentService } from '../development/development.service';
import { QA_BATCH_DISPATCHER, QaBatchDispatcher } from './qa-batch.seam';

const INTERVAL_NAME = 'orchestration-tick';

/** Tallies for one orchestration tick (dispatch wave). */
export interface OrchestrationWave {
  dispatched: number;
  skippedActive: number;
  deferred: number;
}

/**
 * Backend orchestration scheduler (Phase 2.1, ARCHITECTURE.md §4C, DECISIONS_LOG D-023). A polling
 * loop turns manual batch dispatch into a hands-off pipeline: every `ORCHESTRATION_INTERVAL_MS`,
 * while `ORCHESTRATION_ENABLED` and there is idle capacity (`activeRuns < MAX_CONCURRENT_RUNS`), it
 * dispatches pending work for each leg in `ORCHESTRATION_ROLES`. Because pods are one-shot, this
 * "poll-when-idle, continue-until-done" loop lives in the backend, not inside a pod. The Developer
 * leg is active now; the QA leg is an inert seam until Phase 3 binds {@link QA_BATCH_DISPATCHER}.
 * All existing guardrails hold: one-active-run guard (idempotent redispatch), the concurrency cap,
 * and the per-run token/cost hard-stop + `activeDeadlineSeconds` enforced downstream.
 */
@Injectable()
export class OrchestrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestrationService.name);
  private lastTickAt: string | null = null;
  private lastWave: OrchestrationWave | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly jobs: JobsService,
    private readonly projects: ProjectsService,
    private readonly development: DevelopmentService,
    private readonly audit: AuditService,
    @Optional() @Inject(QA_BATCH_DISPATCHER) private readonly qa?: QaBatchDispatcher | null,
  ) {}

  onModuleInit(): void {
    // Not scheduled under test (deterministic tests invoke tick() directly), mirroring LeaseReclaimService.
    if (this.config.isTest) {
      return;
    }
    const interval = setInterval(() => {
      // Never let a rejected tick become an unhandled rejection (would crash the process on Node's
      // default) — a transient ADO/DB error must only skip this tick.
      this.tick().catch((err) => {
        this.logger.error(`Orchestration tick failed: ${(err as Error).message}`);
      });
    }, this.config.orchestrationIntervalMs);
    this.registry.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `Orchestration scheduler armed: every ${this.config.orchestrationIntervalMs}ms, ` +
        `enabled=${this.config.orchestrationEnabled}, roles=[${this.config.orchestrationRoles.join(', ')}], ` +
        `cap=${this.config.maxConcurrentRuns}.`,
    );
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) {
      this.registry.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * One scheduler pass. No-ops when paused (`ORCHESTRATION_ENABLED=false`) or at capacity
   * (`activeRuns >= MAX_CONCURRENT_RUNS`) — toggling the switch off halts *new* dispatch without
   * touching in-flight runs. Otherwise dispatches each configured leg until the capacity budget for
   * this tick is exhausted; the remainder is left for the next tick. Returns the wave tallies.
   */
  async tick(): Promise<OrchestrationWave> {
    this.lastTickAt = new Date().toISOString();
    const wave: OrchestrationWave = { dispatched: 0, skippedActive: 0, deferred: 0 };

    if (!this.config.orchestrationEnabled) {
      this.lastWave = wave;
      return wave; // paused
    }
    const active = await this.jobs.countActive();
    let capacity = this.config.maxConcurrentRuns - active;
    if (capacity <= 0) {
      this.logger.debug(`At capacity (${active}/${this.config.maxConcurrentRuns}); skipping tick.`);
      this.lastWave = wave;
      return wave;
    }

    const projects = await this.projects.findAll();
    for (const role of this.config.orchestrationRoles) {
      if (capacity <= 0) {
        break;
      }
      if (role === 'developer') {
        capacity = await this.runDeveloperLeg(projects, capacity, wave);
      } else if (role === 'qa') {
        capacity = await this.runQaLeg(projects, capacity, wave);
      } else {
        this.logger.warn(`Unknown orchestration role '${role}'; skipping.`);
      }
    }
    this.lastWave = wave;
    return wave;
  }

  /** Developer leg: fan out pending To Do Tasks per project, bounded by the remaining capacity. */
  private async runDeveloperLeg(
    projects: ProjectDocument[],
    startCapacity: number,
    wave: OrchestrationWave,
  ): Promise<number> {
    let capacity = startCapacity;
    for (const project of projects) {
      if (capacity <= 0) {
        break;
      }
      try {
        const result = await this.development.startDevelopmentBatch(project.id as string, {
          maxDispatch: capacity,
        });
        for (const job of result.dispatched) {
          await this.auditDispatch(
            project.id as string,
            job.runId,
            job.workItemId ?? '',
            'developer',
          );
        }
        wave.dispatched += result.dispatched.length;
        wave.skippedActive += result.skippedActive.length;
        wave.deferred += result.deferred.length;
        capacity -= result.dispatched.length;
      } catch (err) {
        // One project's dispatch failure (e.g. ADO unreachable) must not abort the wave for others.
        this.logger.error(
          `Developer leg failed for project ${project.id as string}: ${(err as Error).message}`,
        );
      }
    }
    return capacity;
  }

  /**
   * QA leg: inert until Phase 3 binds a {@link QaBatchDispatcher}. When present, fan out QA pods per
   * project bounded by capacity, mirroring the Developer leg.
   */
  private async runQaLeg(
    projects: ProjectDocument[],
    startCapacity: number,
    wave: OrchestrationWave,
  ): Promise<number> {
    if (!this.qa) {
      this.logger.log(
        'QA leg requested but no QA dispatcher is bound (Phase 3 not present); skipping.',
      );
      return startCapacity;
    }
    let capacity = startCapacity;
    for (const project of projects) {
      if (capacity <= 0) {
        break;
      }
      try {
        const result = await this.qa.startQaBatch(project.id as string, { maxDispatch: capacity });
        for (const d of result.dispatched) {
          await this.auditDispatch(project.id as string, d.runId, d.workItemId, 'qa');
        }
        wave.dispatched += result.dispatched.length;
        capacity -= result.dispatched.length;
      } catch (err) {
        this.logger.error(
          `QA leg failed for project ${project.id as string}: ${(err as Error).message}`,
        );
      }
    }
    return capacity;
  }

  /** Emits a structured (no-secrets) JSON log line + an immutable audit entry for one dispatch. */
  private async auditDispatch(
    projectId: string,
    runId: string,
    workItemId: string,
    role: string,
  ): Promise<void> {
    this.logger.log(JSON.stringify({ event: 'orchestration.dispatch', role, runId, workItemId }));
    await this.audit.append({
      actor: AuditService.actorFrom(null), // system actor
      action: AuditAction.OrchestrationDispatch,
      entityType: 'run',
      entityId: runId,
      projectId,
      metadata: { workItemId, role },
    });
  }

  /** Current scheduler status for the health/observability endpoint. */
  async getStatus(): Promise<{
    enabled: boolean;
    intervalMs: number;
    roles: string[];
    maxConcurrentRuns: number;
    activeRuns: number;
    qaLegAvailable: boolean;
    lastTickAt: string | null;
    lastWave: OrchestrationWave | null;
  }> {
    return {
      enabled: this.config.orchestrationEnabled,
      intervalMs: this.config.orchestrationIntervalMs,
      roles: this.config.orchestrationRoles,
      maxConcurrentRuns: this.config.maxConcurrentRuns,
      activeRuns: await this.jobs.countActive(),
      qaLegAvailable: Boolean(this.qa),
      lastTickAt: this.lastTickAt,
      lastWave: this.lastWave,
    };
  }
}

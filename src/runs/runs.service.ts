import { Injectable, Logger } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { JobRole } from '../jobs/job-state';
import { TaskTransitionService } from '../development/task-transition.service';
import { PlanningService } from '../planning/planning.service';
import { DevQueueService } from '../development/dev-queue.service';
import { QaQueueService } from '../qa/qa-queue.service';
import { RunsGateway } from './runs.gateway';
import { RunEventDto, RunEventType, RunResultStatus } from './dto/run-event.dto';

/**
 * Ingests run events from the Agent Runner and updates the jobs record, then relays every event to
 * the UI (api/runs-events.md). The pod authenticates each POST with its per-run token; the runId
 * itself is used as the lease holder id since exactly one pod owns a run. Ingest is idempotent —
 * a duplicate lifecycle event is a harmless no-op.
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly gateway: RunsGateway,
    private readonly transitions: TaskTransitionService,
    private readonly queue: DevQueueService,
    private readonly qaQueue: QaQueueService,
    private readonly planning: PlanningService,
  ) {}

  async ingest(runId: string, event: RunEventDto): Promise<void> {
    switch (event.type) {
      case RunEventType.Running:
        // Claim on behalf of the pod (runId is the lease holder) then mark Running.
        await this.jobs.claim(runId, runId);
        await this.jobs.markRunning(runId, runId);
        break;
      case RunEventType.Heartbeat:
        await this.jobs.heartbeat(runId, runId);
        break;
      case RunEventType.Result:
        await this.applyResult(runId, event);
        break;
      case RunEventType.Log:
      case RunEventType.Tool:
      case RunEventType.Ado:
        // Progress events carry no state change; they are relayed to the UI.
        break;
    }
    this.gateway.relay(runId, event);
  }

  private async applyResult(runId: string, event: RunEventDto): Promise<void> {
    const result = {
      durationMs: event.durationMs ?? 0,
      tokens: event.tokens ?? 0,
      cost: event.cost ?? 0,
      logsRef: event.logsRef ?? null,
      output: event.output ?? null,
      workerBuild: event.workerBuild ?? null,
      filesChanged: event.filesChanged ?? 0,
      commits: event.commits ?? [],
      adoChanges: event.adoChanges ?? [],
      artifacts: event.artifacts ?? [],
      workspacePath: event.workspacePath ?? null,
    };
    switch (event.status) {
      case RunResultStatus.Completed:
        await this.jobs.complete(runId, result);
        // A planning run that finished without posting a plan or a backlog delivered nothing; the
        // draft must say so rather than waiting on it for ever.
        await this.planning.noteRunFinished(runId);
        await this.completeDeveloperTask(runId);
        // Hands the next queued item to its agent. Each is a no-op unless the run belonged to
        // that queue, so a Developer run never disturbs the QA queue or the other way round.
        await this.queue.onRunFinished(runId, 'completed');
        await this.qaQueue.onRunFinished(runId, 'completed');
        break;
      case RunResultStatus.Blocked:
        await this.jobs.block(runId, 'Reported blocked by runner');
        break;
      case RunResultStatus.Failed:
      default:
        await this.jobs.fail(runId, result);
        await this.planning.noteRunFinished(runId);
        // A failed run never produces Done — record it and leave the Task where it is.
        await this.recordDeveloperFailure(runId, 'The Claude Developer Agent run failed.');
        // Stops the queue rather than building later work on a broken run.
        await this.queue.onRunFinished(runId, 'failed');
        await this.qaQueue.onRunFinished(runId, 'failed');
        break;
    }
    this.logger.log(`Run ${runId} finished with status ${event.status ?? 'Failed'}`);
  }

  /**
   * **Orchestrator-owned** Task completion: when a Developer run finishes successfully, the Task
   * moves `In Progress → Done` in Azure DevOps. This is the only path to Done — users cannot drive
   * it from the board. Best-effort: a failure here is logged/audited and never breaks run ingest.
   */
  /** Audits a failed Developer run against its Task. Best-effort; never breaks run ingest. */
  private async recordDeveloperFailure(runId: string, reason: string): Promise<void> {
    try {
      const job = await this.jobs.getByRunId(runId);
      if (job.role !== JobRole.Developer || !job.workItemId) return;
      await this.transitions.recordExecutionFailure(
        job.projectId?.toString() ?? null,
        job.workItemId,
        runId,
        reason,
      );
    } catch (err) {
      this.logger.warn(
        `Could not record the execution failure for run ${runId}: ${(err as Error).message}`,
      );
    }
  }

  private async completeDeveloperTask(runId: string): Promise<void> {
    try {
      const job = await this.jobs.getByRunId(runId);
      if (job.role !== JobRole.Developer || !job.workItemId) return;
      await this.transitions.completeTask(job.projectId?.toString() ?? null, job.workItemId, runId);
    } catch (err) {
      this.logger.warn(`Could not complete the Task for run ${runId}: ${(err as Error).message}`);
    }
  }
}

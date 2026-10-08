import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../common/config/app-config.service';
import { JobDispatchService } from './job-dispatch.service';
import { JobsService } from './jobs.service';
import { JobDocument } from './schemas/job.schema';

const INTERVAL_NAME = 'lease-reclaim';

/**
 * How long a job may sit Queued without a pod ever claiming it before the scheduler re-dispatches
 * it. A pod claims its job within seconds of starting, so this only needs to clear normal pod
 * start-up (scheduling + image pull); the margin keeps a slow-but-healthy start from being
 * re-dispatched. Combined with the 60s tick, a dispatch that never created a pod self-heals in
 * roughly 1.5-2.5 minutes.
 */
export const STALE_QUEUED_MS = 90_000;

/**
 * How many times a run may be re-dispatched before it is called failed.
 *
 * Reclaim exists for a pod that died for a passing reason — a node restart, a dropped network.
 * A pod that dies for a permanent reason dies the same way every time, and reclaim cannot tell the
 * two apart. Without a ceiling the run is re-dispatched for ever: a Task whose clone URL was
 * malformed went round ten times, and because a pod that dies before reporting looks exactly like
 * one still working, the board said "Agent running" throughout. Reaching this ceiling is the
 * signal that retrying is not the answer, so the run is failed with that said plainly.
 */
export const MAX_RUN_ATTEMPTS = 3;

/**
 * Scheduled lease-reclaim (ARCHITECTURE.md §4A, §10). On a fixed interval
 * (`RUN_RECLAIM_INTERVAL_MS`) it recovers the two ways a run can stall with no pod behind it — a
 * lease that expired (dead/stuck pod whose heartbeat stopped) and a dispatch that never created a
 * pod at all — and **re-dispatches each as a fresh pod** through the shared
 * {@link JobDispatchService}. This is retry-not-resume: the new pod reconstructs its state from
 * Azure DevOps + git (fresh clone, re-read work-item state), never resuming the old session. A
 * per-run token is reissued on dispatch, so a leaked token from the dead run does not carry over.
 */
@Injectable()
export class LeaseReclaimService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaseReclaimService.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly dispatcher: JobDispatchService,
    private readonly config: AppConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    // Not scheduled under test to keep unit tests deterministic; tick() is invoked directly there.
    if (this.config.isTest) {
      return;
    }
    const interval = setInterval(() => {
      void this.tick();
    }, this.config.runReclaimIntervalMs);
    this.registry.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Lease-reclaim scheduled every ${this.config.runReclaimIntervalMs}ms.`);
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) {
      this.registry.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * One reclaim pass. Covers the two ways a run can stall with nothing running behind it:
   * an **expired lease** (the pod died mid-run) and a **dispatch that never created a pod** (the
   * execution backend was unreachable, e.g. the cluster was still starting). Both are re-dispatched
   * as a fresh pod. Returns the count successfully re-dispatched (for observability + tests).
   */
  async tick(nowMs = Date.now()): Promise<number> {
    const expired = await this.redispatchExpiredLeases(nowMs);
    const neverStarted = await this.redispatchNeverStarted(nowMs);
    return expired + neverStarted;
  }

  /** Requeues jobs whose lease expired (dead runner) and re-dispatches each as a fresh pod. */
  private async redispatchExpiredLeases(nowMs: number): Promise<number> {
    const reclaimed = await this.jobs.reclaimExpiredLeases(nowMs);
    if (reclaimed.length === 0) {
      return 0;
    }
    this.logger.warn(`Reclaimed ${reclaimed.length} expired-lease job(s); re-dispatching.`);
    return this.redispatchAll(reclaimed);
  }

  /**
   * Re-dispatches jobs still Queued past {@link STALE_QUEUED_MS} with no pod ever claiming them.
   * Nothing else retries these (lease reclaim only rescues Claimed/Running), so a dispatch that
   * failed while the cluster was down would otherwise leave the Task In Progress forever. Safe to
   * repeat: the K8s Job is named `aijob-<runId>`, so if a pod does exist the create is rejected
   * rather than starting a second agent, and the per-run token is a stateless HMAC — reissuing it
   * does not invalidate the one an already-running pod holds.
   */
  private async redispatchNeverStarted(nowMs: number): Promise<number> {
    const stale = await this.jobs.findQueuedNeverStarted(STALE_QUEUED_MS, nowMs);
    if (stale.length === 0) {
      return 0;
    }
    this.logger.warn(`${stale.length} queued job(s) never started a pod; re-dispatching.`);
    return this.redispatchAll(stale);
  }

  /**
   * Dispatches a fresh pod per job. A single failure is logged and does not stop the others — the
   * job stays Queued and is retried on the next tick.
   */
  private async redispatchAll(jobs: JobDocument[]): Promise<number> {
    let redispatched = 0;
    for (const job of jobs) {
      if ((job.attempts ?? 0) >= MAX_RUN_ATTEMPTS) {
        await this.giveUp(job);
        continue;
      }
      try {
        await this.dispatcher.dispatch(job);
        redispatched += 1;
      } catch (err) {
        this.logger.error(
          `Re-dispatch failed for run ${job.runId}; left Queued for the next tick: ${
            (err as Error).message
          }`,
        );
      }
    }
    return redispatched;
  }

  /**
   * Stops retrying a run that keeps dying, and says so where someone will see it.
   *
   * The state matters more than the retry: a run left Running is indistinguishable from one that
   * is working, so the thing that was actually broken stayed invisible while the cluster quietly
   * started the same doomed pod again and again.
   */
  private async giveUp(job: JobDocument): Promise<void> {
    const message =
      `Gave up after ${job.attempts} attempts: the pod for this run kept failing before it could ` +
      'report anything. The run was not retried again — look at the pod logs for the reason, fix ' +
      'it, and start the Task again.';
    this.logger.error(`Run ${job.runId} ${message}`);
    try {
      await this.jobs.fail(job.runId, {
        status: 'Failed',
        output: message,
      } as unknown as Parameters<JobsService['fail']>[1]);
    } catch (err) {
      this.logger.error(
        `Could not mark run ${job.runId} failed after exhausting its attempts: ${
          (err as Error).message
        }`,
      );
    }
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppConfigService } from '../common/config/app-config.service';
import { canTransition, isTerminal, JobRole, JobState, PermissionMode } from './job-state';
import { Job, JobDocument, RunResult } from './schemas/job.schema';

/** Input to enqueue a new job. */
export interface EnqueueJobSpec {
  runId: string;
  role: JobRole;
  projectId: string;
  workItemId?: string | null;
  repo?: string | null;
  permissionMode: PermissionMode;
}

/**
 * Jobs-table lifecycle with lease + heartbeat and one-active-run-per-work-item
 * (ARCHITECTURE.md §5, DEVELOPMENT_GUIDELINES §5). Concurrency-sensitive operations (claim,
 * heartbeat, run transition) use atomic conditional updates so only one runner can ever hold a
 * job; terminal transitions are validated against the state machine.
 */
@Injectable()
export class JobsService {
  constructor(
    @InjectModel(Job.name) private readonly jobModel: Model<JobDocument>,
    private readonly config: AppConfigService,
  ) {}

  /** Enqueues a job, rejecting a duplicate active run for the same work item. */
  async enqueue(spec: EnqueueJobSpec): Promise<JobDocument> {
    if (spec.workItemId) {
      const active = await this.findActiveForWorkItem(spec.workItemId);
      if (active) {
        throw new ConflictException(
          `An active run already exists for work item ${spec.workItemId}.`,
        );
      }
    }
    return new this.jobModel({
      runId: spec.runId,
      role: spec.role,
      projectId: new Types.ObjectId(spec.projectId),
      workItemId: spec.workItemId ?? null,
      repo: spec.repo ?? null,
      permissionMode: spec.permissionMode,
      state: JobState.Queued,
    }).save();
  }

  /** Returns the current active (non-terminal) job for a work item, if any. */
  findActiveForWorkItem(workItemId: string): Promise<JobDocument | null> {
    return this.jobModel
      .findOne({ workItemId, state: { $nin: [...this.terminalStates()] } })
      .exec();
  }

  /**
   * Returns the set of work-item ids that currently have an **active QA run** (a `role=qa` job in a
   * non-terminal state). The board uses this to show a Story "under test" in the Testing column
   * (ARCHITECTURE.md §4B) — a read-only projection of run status, not a two-way sync.
   */
  async activeQaWorkItemIds(): Promise<Set<string>> {
    return this.activeWorkItemIdsForRole(JobRole.QA);
  }

  /**
   * Returns the set of work-item ids that currently have an **active Developer run**. The
   * Development board uses this to flag the Tasks an agent is working on right now — a read-only
   * projection of run status, not a two-way sync.
   */
  async activeDeveloperWorkItemIds(): Promise<Set<string>> {
    return this.activeWorkItemIdsForRole(JobRole.Developer);
  }

  /** Work-item ids with a non-terminal job for `role` (shared by the QA/Developer projections). */
  private async activeWorkItemIdsForRole(role: JobRole): Promise<Set<string>> {
    const ids = await this.jobModel
      .find({
        role,
        state: { $nin: [...this.terminalStates()] },
        workItemId: { $ne: null },
      })
      .distinct('workItemId')
      .exec();
    return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0));
  }

  private terminalStates(): JobState[] {
    return [JobState.Completed, JobState.Cancelled, JobState.Failed];
  }

  /**
   * Counts active (non-terminal) jobs across all projects — the global concurrency figure the
   * orchestration scheduler compares against `MAX_CONCURRENT_RUNS` before dispatching (Phase 2.1).
   */
  countActive(): Promise<number> {
    return this.jobModel.countDocuments({ state: { $nin: [...this.terminalStates()] } }).exec();
  }

  findByRunId(runId: string): Promise<JobDocument | null> {
    return this.jobModel.findOne({ runId }).exec();
  }

  /** Lists runs for a project, newest first (run monitor). */
  listForProject(projectId: string): Promise<JobDocument[]> {
    if (!Types.ObjectId.isValid(projectId)) {
      return Promise.resolve([]);
    }
    return this.jobModel
      .find({ projectId: new Types.ObjectId(projectId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async getByRunId(runId: string): Promise<JobDocument> {
    const job = await this.findByRunId(runId);
    if (!job) {
      throw new NotFoundException(`Job ${runId} not found.`);
    }
    return job;
  }

  private newLeaseExpiry(nowMs: number): Date {
    return new Date(nowMs + this.config.runLeaseTtlMs);
  }

  /**
   * Atomically claims a specific queued job for `runnerId` (Queued → Claimed + lease). Returns the
   * claimed job, or null if it was not claimable (already claimed by another runner / not Queued).
   */
  async claim(runId: string, runnerId: string, nowMs = Date.now()): Promise<JobDocument | null> {
    return this.jobModel
      .findOneAndUpdate(
        { runId, state: JobState.Queued },
        {
          $set: {
            state: JobState.Claimed,
            lease: {
              runnerId,
              acquiredAt: new Date(nowMs),
              lastHeartbeatAt: new Date(nowMs),
              expiresAt: this.newLeaseExpiry(nowMs),
            },
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .exec();
  }

  /**
   * Refreshes the lease for the current holder (Claimed/Running only). Returns true if the lease
   * was refreshed; false if the caller no longer holds it (lost/expired/terminal).
   */
  async heartbeat(runId: string, runnerId: string, nowMs = Date.now()): Promise<boolean> {
    const res = await this.jobModel
      .updateOne(
        {
          runId,
          'lease.runnerId': runnerId,
          state: { $in: [JobState.Claimed, JobState.Running] },
        },
        {
          $set: {
            'lease.lastHeartbeatAt': new Date(nowMs),
            'lease.expiresAt': this.newLeaseExpiry(nowMs),
          },
        },
      )
      .exec();
    return res.modifiedCount === 1;
  }

  /** Marks a claimed (or blocked→resumed) job Running, verifying the lease holder. */
  async markRunning(runId: string, runnerId: string, nowMs = Date.now()): Promise<boolean> {
    const res = await this.jobModel
      .updateOne(
        {
          runId,
          'lease.runnerId': runnerId,
          state: { $in: [JobState.Claimed, JobState.Blocked] },
        },
        {
          $set: {
            state: JobState.Running,
            'lease.lastHeartbeatAt': new Date(nowMs),
            'lease.expiresAt': this.newLeaseExpiry(nowMs),
          },
        },
      )
      .exec();
    return res.modifiedCount === 1;
  }

  /** Applies a validated terminal/blocked transition and records the result. */
  private async transition(
    runId: string,
    to: JobState,
    patch: Partial<Pick<Job, 'result' | 'blockedReason'>> = {},
  ): Promise<JobDocument> {
    const job = await this.getByRunId(runId);
    if (!canTransition(job.state, to)) {
      throw new ConflictException(`Illegal transition ${job.state} → ${to} for run ${runId}.`);
    }
    job.state = to;
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.blockedReason !== undefined) job.blockedReason = patch.blockedReason;
    if (isTerminal(to)) {
      job.lease = { runnerId: null, acquiredAt: null, lastHeartbeatAt: null, expiresAt: null };
    }
    return job.save();
  }

  complete(runId: string, result: RunResult): Promise<JobDocument> {
    return this.transition(runId, JobState.Completed, { result });
  }

  /**
   * A failed run keeps its result. The run that failed is the one whose output is worth
   * reading, and discarding it left `result: null` on exactly the job anyone would
   * investigate — the agent's own account of what went wrong died with the pod.
   */
  fail(runId: string, result?: RunResult): Promise<JobDocument> {
    return this.transition(runId, JobState.Failed, result ? { result } : {});
  }

  cancel(runId: string): Promise<JobDocument> {
    return this.transition(runId, JobState.Cancelled);
  }

  block(runId: string, reason: string): Promise<JobDocument> {
    return this.transition(runId, JobState.Blocked, { blockedReason: reason });
  }

  /**
   * Queued jobs that **never got a pod**: still Queued, no lease, and untouched for `staleMs`. A pod
   * claims its job within seconds of starting, so a job that has sat Queued well past that is a
   * dispatch that silently failed — typically the execution backend was unreachable (cluster
   * starting/down). Lease reclaim does not cover these (it only rescues Claimed/Running), so without
   * this they sit Queued forever while the Task shows In Progress with nothing behind it.
   *
   * Age is measured from `updatedAt`, not `createdAt`, so a job that lease reclaim just requeued is
   * not also re-dispatched by this pass — while a requeued job whose re-dispatch *also* failed to
   * produce a pod is picked up once the grace period elapses again.
   */
  async findQueuedNeverStarted(staleMs: number, nowMs = Date.now()): Promise<JobDocument[]> {
    return this.jobModel
      .find({
        state: JobState.Queued,
        'lease.acquiredAt': null,
        updatedAt: { $lt: new Date(nowMs - staleMs) },
      })
      .exec();
  }

  /**
   * Requeues jobs whose lease has expired (dead runner) so they can be re-dispatched — retry from
   * authoritative state, not live-session resume (ARCHITECTURE.md §10). Each candidate is reclaimed
   * with an atomic, still-expired-guarded update so a job whose lease was renewed between the scan
   * and the write is left alone. Returns the jobs actually reclaimed (now Queued) so the caller can
   * re-dispatch a fresh pod for each.
   */
  async reclaimExpiredLeases(nowMs = Date.now()): Promise<JobDocument[]> {
    const expiredFilter = {
      state: { $in: [JobState.Claimed, JobState.Running] },
      'lease.expiresAt': { $lt: new Date(nowMs) },
    };
    const candidates = await this.jobModel.find(expiredFilter).exec();
    const reclaimed: JobDocument[] = [];
    for (const candidate of candidates) {
      const doc = await this.jobModel
        .findOneAndUpdate(
          { _id: candidate._id, ...expiredFilter },
          {
            $set: {
              state: JobState.Queued,
              lease: { runnerId: null, acquiredAt: null, lastHeartbeatAt: null, expiresAt: null },
            },
          },
          { new: true },
        )
        .exec();
      if (doc) {
        reclaimed.push(doc);
      }
    }
    return reclaimed;
  }
}

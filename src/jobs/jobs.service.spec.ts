import { ConflictException } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Model } from 'mongoose';
import { AppConfigService } from '../common/config/app-config.service';
import { JobsService } from './jobs.service';
import { JobRole, JobState, PermissionMode } from './job-state';
import { Job, JobDocument, JobSchema } from './schemas/job.schema';

/** Real in-memory Mongo so the atomic claim/heartbeat/one-active-run logic is genuinely exercised. */
describe('JobsService (in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let model: Model<JobDocument>;
  let service: JobsService;

  const projectId = new mongoose.Types.ObjectId().toString();
  const config = { runLeaseTtlMs: 120000, runHeartbeatMs: 30000 } as AppConfigService;

  const spec = (over: Partial<{ runId: string; workItemId: string | null }> = {}) => ({
    runId: over.runId ?? 'run-1',
    role: JobRole.SM,
    projectId,
    workItemId: over.workItemId === undefined ? '1234' : over.workItemId,
    permissionMode: PermissionMode.Plan,
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    model = mongoose.model(Job.name, JobSchema) as unknown as Model<JobDocument>;
    service = new JobsService(model, config);
  });

  afterEach(async () => {
    await model.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('enqueues a job in Queued state', async () => {
    const job = await service.enqueue(spec());
    expect(job.state).toBe(JobState.Queued);
    expect(job.runId).toBe('run-1');
  });

  it('rejects a duplicate active run for the same work item', async () => {
    await service.enqueue(spec({ runId: 'run-1' }));
    await expect(service.enqueue(spec({ runId: 'run-2' }))).rejects.toThrow(ConflictException);
  });

  it('enforces one active developer run per Task (Phase 2 dispatch guard)', async () => {
    const devSpec = (runId: string) => ({
      runId,
      role: JobRole.Developer,
      projectId,
      workItemId: '18223',
      repo: 'NQAI-DevAutomation',
      permissionMode: PermissionMode.BypassPermissions,
    });
    await service.enqueue(devSpec('dev-1'));
    await expect(service.enqueue(devSpec('dev-2'))).rejects.toThrow(ConflictException);
  });

  it('allows a new run for a work item once the prior run is terminal', async () => {
    await service.enqueue(spec({ runId: 'run-1' }));
    await service.claim('run-1', 'runner-a');
    await service.markRunning('run-1', 'runner-a');
    await service.complete('run-1', {
      durationMs: 1,
      tokens: 0,
      cost: 0,
      logsRef: null,
      filesChanged: 0,
      commits: [],
      adoChanges: [],
      artifacts: [],
      workspacePath: null,
      output: null,
      workerBuild: null,
    });
    await expect(service.enqueue(spec({ runId: 'run-2' }))).resolves.toBeDefined();
  });

  it('lets only one runner claim a job (atomic)', async () => {
    await service.enqueue(spec());
    const [a, b] = await Promise.all([
      service.claim('run-1', 'runner-a'),
      service.claim('run-1', 'runner-b'),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe(JobState.Claimed);
  });

  it('heartbeat extends the lease only for the holder', async () => {
    await service.enqueue(spec());
    await service.claim('run-1', 'runner-a', 1_000_000);
    await expect(service.heartbeat('run-1', 'runner-b')).resolves.toBe(false);
    await expect(service.heartbeat('run-1', 'runner-a')).resolves.toBe(true);
  });

  it('reclaims jobs with an expired lease back to Queued', async () => {
    await service.enqueue(spec());
    await service.claim('run-1', 'runner-a', 1000); // lease expires at 1000+120000
    const reclaimed = await service.reclaimExpiredLeases(1000 + 120000 + 1);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].runId).toBe('run-1');
    expect(reclaimed[0].state).toBe(JobState.Queued);
    const job = await service.getByRunId('run-1');
    expect(job.state).toBe(JobState.Queued);
    expect(job.lease.runnerId).toBeNull();
  });

  describe('findQueuedNeverStarted', () => {
    /** 90s grace, measured from the job's last write — the scheduler's STALE_QUEUED_MS. */
    const grace = 90000;
    const past = (ms: number) => Date.now() + ms;

    it('finds a queued job that no pod ever claimed', async () => {
      await service.enqueue(spec());
      const stale = await service.findQueuedNeverStarted(grace, past(grace + 1000));
      expect(stale.map((j) => j.runId)).toEqual(['run-1']);
    });

    it('leaves a freshly-dispatched job alone during the grace period', async () => {
      await service.enqueue(spec());
      expect(await service.findQueuedNeverStarted(grace, past(1000))).toHaveLength(0);
    });

    it('ignores a job a pod has already claimed', async () => {
      await service.enqueue(spec());
      await service.claim('run-1', 'runner-a');
      expect(await service.findQueuedNeverStarted(grace, past(grace + 1000))).toHaveLength(0);
    });

    /**
     * A reclaimed job is Queued again with a cleared lease, so age is measured from its last write:
     * the reclaim pass re-dispatches it in the same tick, and a second dispatch would be redundant.
     */
    it('ignores a job lease reclaim just requeued', async () => {
      await service.enqueue(spec());
      await service.claim('run-1', 'runner-a', 1000);
      await service.reclaimExpiredLeases(1000 + 120000 + 1);
      expect(await service.findQueuedNeverStarted(grace, past(grace - 1000))).toHaveLength(0);
    });

    it('retries a requeued job whose re-dispatch also produced no pod', async () => {
      await service.enqueue(spec());
      await service.claim('run-1', 'runner-a', 1000);
      await service.reclaimExpiredLeases(1000 + 120000 + 1);
      const stale = await service.findQueuedNeverStarted(grace, past(grace + 1000));
      expect(stale.map((j) => j.runId)).toEqual(['run-1']);
    });
  });

  it('rejects an illegal transition', async () => {
    await service.enqueue(spec());
    // Queued → Completed is not allowed.
    await expect(
      service.complete('run-1', {
        durationMs: 0,
        tokens: 0,
        cost: 0,
        logsRef: null,
        filesChanged: 0,
        commits: [],
        adoChanges: [],
        artifacts: [],
        workspacePath: null,
        output: null,
        workerBuild: null,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('supports Running → Blocked → Running (external wait, not failure)', async () => {
    await service.enqueue(spec());
    await service.claim('run-1', 'runner-a');
    await service.markRunning('run-1', 'runner-a');
    await service.block('run-1', 'awaiting approval');
    const blocked = await service.getByRunId('run-1');
    expect(blocked.state).toBe(JobState.Blocked);
    await expect(service.markRunning('run-1', 'runner-a')).resolves.toBe(true);
  });
});

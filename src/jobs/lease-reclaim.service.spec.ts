import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../common/config/app-config.service';
import { JobDispatchService } from './job-dispatch.service';
import { JobsService } from './jobs.service';
import { JobRole, JobState } from './job-state';
import { JobDocument } from './schemas/job.schema';
import { LeaseReclaimService, MAX_RUN_ATTEMPTS, STALE_QUEUED_MS } from './lease-reclaim.service';

/** Unit tests for the reclaim pass logic (tick); scheduling itself is disabled in test mode. */
describe('LeaseReclaimService.tick', () => {
  let jobs: { reclaimExpiredLeases: jest.Mock; findQueuedNeverStarted: jest.Mock; fail: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let service: LeaseReclaimService;

  const config = { isTest: true, runReclaimIntervalMs: 60000 } as AppConfigService;

  const job = (runId: string, attempts = 0): JobDocument =>
    ({ runId, role: JobRole.Developer, state: JobState.Queued, attempts }) as JobDocument;

  beforeEach(() => {
    jobs = {
      reclaimExpiredLeases: jest.fn().mockResolvedValue([]),
      findQueuedNeverStarted: jest.fn().mockResolvedValue([]),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    service = new LeaseReclaimService(
      jobs as unknown as JobsService,
      dispatcher as unknown as JobDispatchService,
      config,
      {} as SchedulerRegistry,
    );
  });

  it('does nothing when nothing is stalled', async () => {
    expect(await service.tick()).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('re-dispatches a fresh pod for every reclaimed job (retry-not-resume)', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('a'), job('b')]);
    expect(await service.tick()).toBe(2);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runId: 'a' }));
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runId: 'b' }));
  });

  it('keeps going when one re-dispatch fails (retried next tick)', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('a'), job('b')]);
    dispatcher.dispatch.mockRejectedValueOnce(new Error('no cluster'));
    expect(await service.tick()).toBe(1); // one succeeded, one failed
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('re-dispatches a queued job that never got a pod (cluster was down at dispatch)', async () => {
    jobs.findQueuedNeverStarted.mockResolvedValue([job('stuck')]);
    expect(await service.tick(1_000_000)).toBe(1);
    // Grace period so a slow-but-healthy pod start is not re-dispatched underneath itself.
    expect(jobs.findQueuedNeverStarted).toHaveBeenCalledWith(STALE_QUEUED_MS, 1_000_000);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runId: 'stuck' }));
  });

  it('recovers expired-lease and never-started jobs in the same pass', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('expired')]);
    jobs.findQueuedNeverStarted.mockResolvedValue([job('stuck')]);
    expect(await service.tick()).toBe(2);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('leaves a never-started job Queued when the cluster is still unreachable', async () => {
    jobs.findQueuedNeverStarted.mockResolvedValue([job('stuck')]);
    dispatcher.dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await service.tick()).toBe(0); // retried again on the next tick
  });
});

/**
 * When retrying stops being the answer.
 *
 * Reclaim exists for a pod that died for a passing reason. A pod that dies for a permanent one
 * dies identically every time, and reclaim cannot tell them apart. A Task whose clone URL was
 * malformed went round ten times — and because a pod that dies before reporting looks exactly like
 * one still working, the board said "Agent running" the whole time while the real error sat in pod
 * logs nobody had reason to open.
 */
describe('LeaseReclaimService attempt ceiling', () => {
  let jobs: { reclaimExpiredLeases: jest.Mock; findQueuedNeverStarted: jest.Mock; fail: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let service: LeaseReclaimService;

  const config = { isTest: true, runReclaimIntervalMs: 60000 } as AppConfigService;
  const job = (runId: string, attempts: number): JobDocument =>
    ({ runId, role: JobRole.Developer, state: JobState.Queued, attempts }) as JobDocument;

  beforeEach(() => {
    jobs = {
      reclaimExpiredLeases: jest.fn().mockResolvedValue([]),
      findQueuedNeverStarted: jest.fn().mockResolvedValue([]),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    service = new LeaseReclaimService(
      jobs as unknown as JobsService,
      dispatcher as unknown as JobDispatchService,
      config,
      {} as SchedulerRegistry,
    );
  });

  it('still retries a run that has attempts left', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('a', MAX_RUN_ATTEMPTS - 1)]);
    await service.tick();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('stops re-dispatching once the ceiling is reached', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('a', MAX_RUN_ATTEMPTS)]);
    await service.tick();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  /** Left Running, it is indistinguishable from a run that is working. */
  it('marks the run failed instead of leaving it looking busy', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('a', MAX_RUN_ATTEMPTS)]);
    await service.tick();
    expect(jobs.fail).toHaveBeenCalledWith('a', expect.objectContaining({ status: 'Failed' }));
  });

  it('says why it gave up, and where to look', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('a', MAX_RUN_ATTEMPTS)]);
    await service.tick();
    const output = (jobs.fail.mock.calls[0][1] as { output: string }).output;
    expect(output).toMatch(/gave up after/i);
    expect(output).toMatch(/pod logs/i);
  });

  /** One doomed run must not stop a healthy one being retried in the same pass. */
  it('still retries the other runs in the batch', async () => {
    jobs.reclaimExpiredLeases.mockResolvedValue([job('doomed', MAX_RUN_ATTEMPTS), job('ok', 0)]);
    await service.tick();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch.mock.calls[0][0].runId).toBe('ok');
  });
});

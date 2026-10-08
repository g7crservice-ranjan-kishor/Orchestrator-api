import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Model } from 'mongoose';
import { QaQueueService } from './qa-queue.service';
import { QaQueue, QaQueueDocument, QaQueueSchema } from './schemas/qa-queue.schema';
import { DevQueueItemState, DevQueueStatus } from '../development/schemas/dev-queue.schema';
import { QaService } from './qa.service';
import { JobsService } from '../jobs/jobs.service';
import { AppConfigService } from '../common/config/app-config.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/**
 * The QA queue against real persistence.
 *
 * The gap it closes: `startQaBatch` dispatches only what the concurrency cap allows and returns the
 * rest as `deferred` — a list the disabled scheduler was supposed to drain. Selecting twenty
 * Stories tested one and dropped nineteen without a word. These tests are about the nineteen.
 *
 * `QaService` is stubbed: it is the existing mechanism with its own tests. What matters here is
 * that the queue calls it once, for the right Story, never overlaps runs, and remembers the rest.
 */
describe('QaQueueService (in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let model: Model<QaQueueDocument>;
  let service: QaQueueService;
  let qa: { startQaBatch: jest.Mock };
  let jobs: { countActive: jest.Mock };
  const projectId = new mongoose.Types.ObjectId().toString();
  const user = { userId: 'u1', email: 'qa@example.com' } as AuthenticatedUser;

  /** A start that dispatches, as the real one does when the Story is eligible. */
  const dispatches = (runId: string) =>
    jest.fn().mockImplementation((_p: string, opts: { workItemIds: string[] }) =>
      Promise.resolve({
        dispatched: [
          { runId, workItemId: opts.workItemIds[0], title: 't', kind: 'story' as const },
        ],
        skippedActive: [],
        ineligible: [],
        deferred: [],
        candidates: 1,
        dryRun: false,
      }),
    );

  /** A start that refuses, with the API's own reason. */
  const refuses = (reason: string) =>
    jest.fn().mockImplementation((_p: string, opts: { workItemIds: string[] }) =>
      Promise.resolve({
        dispatched: [],
        skippedActive: [],
        ineligible: [{ workItemId: opts.workItemIds[0], reason }],
        deferred: [],
        candidates: 1,
        dryRun: false,
      }),
    );

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    model = mongoose.model(QaQueue.name, QaQueueSchema) as unknown as Model<QaQueueDocument>;
  });

  beforeEach(async () => {
    await model.deleteMany({});
    qa = { startQaBatch: dispatches('run-1') };
    jobs = { countActive: jest.fn().mockResolvedValue(0) };
    service = new QaQueueService(
      model,
      jobs as unknown as JobsService,
      { maxConcurrentRuns: 1 } as AppConfigService,
      qa as unknown as QaService,
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('remembers the whole selection and starts only the first', async () => {
    const view = await service.enqueue(projectId, ['413', '414', '415'], user);

    expect(view.items).toHaveLength(3);
    expect(view.items[0].state).toBe(DevQueueItemState.Running);
    expect(view.items[1].state).toBe(DevQueueItemState.Queued);
    expect(view.items[2].state).toBe(DevQueueItemState.Queued);
    expect(qa.startQaBatch).toHaveBeenCalledTimes(1);
  });

  /** The whole point: the Stories the cap deferred are still there after the response. */
  it('survives the request that created it', async () => {
    await service.enqueue(projectId, ['413', '414'], user);
    const fresh = await service.view(projectId);
    expect(fresh.items.map((i) => i.workItemId)).toEqual(['413', '414']);
  });

  it('starts the next Story when a run finishes, in the selected order', async () => {
    await service.enqueue(projectId, ['413', '414', '415'], user);

    qa.startQaBatch = dispatches('run-2');
    (service as unknown as { qa: unknown }).qa = qa;
    await service.onRunFinished('run-1', 'completed');

    expect(qa.startQaBatch.mock.calls[0][1].workItemIds).toEqual(['414']);
    const view = await service.view(projectId);
    expect(view.items[0].state).toBe(DevQueueItemState.Done);
    expect(view.items[1].state).toBe(DevQueueItemState.Running);
  });

  it('never overlaps runs, whatever it is asked', async () => {
    await service.enqueue(projectId, ['413', '414'], user);
    await service.drain(projectId);
    await service.drain(projectId);
    expect(qa.startQaBatch).toHaveBeenCalledTimes(1);
  });

  it('waits when the concurrency cap leaves no room', async () => {
    jobs.countActive.mockResolvedValue(1);
    const view = await service.enqueue(projectId, ['413'], user);
    expect(qa.startQaBatch).not.toHaveBeenCalled();
    expect(view.items[0].state).toBe(DevQueueItemState.Queued);
  });

  it('halts on a failed run, keeping the order for a person to resume', async () => {
    await service.enqueue(projectId, ['413', '414'], user);
    await service.onRunFinished('run-1', 'failed');

    const view = await service.view(projectId);
    expect(view.status).toBe(DevQueueStatus.Halted);
    expect(view.haltedReason).toContain('413');
    expect(view.items[0].state).toBe(DevQueueItemState.Failed);
    expect(view.items[1].state).toBe(DevQueueItemState.Queued);
    expect(qa.startQaBatch).toHaveBeenCalledTimes(1); // nothing new started
  });

  /** Same rule as Development: what broke is retried before the work queued behind it. */
  it('retries the failed Story first when resumed', async () => {
    await service.enqueue(projectId, ['413', '414'], user);
    await service.onRunFinished('run-1', 'failed');

    qa.startQaBatch = dispatches('run-2');
    (service as unknown as { qa: unknown }).qa = qa;
    const view = await service.resume(projectId);

    expect(view.status).toBe(DevQueueStatus.Active);
    expect(qa.startQaBatch.mock.calls[0][1].workItemIds).toEqual(['413']);
    expect(view.items[0].runId).toBe('run-2');
  });

  /**
   * A Story that can never start is stepped over, not retried for ever — and not allowed to stop
   * the wave either.
   *
   * It used to halt the queue. That conflated two different things: a QA run that *failed* is
   * usually systemic and worth stopping for, but a Story that was never set up properly says
   * nothing about the ones behind it. On the Employee Management System one Story with no
   * repository tag paused the eighteen queued after it.
   */
  it('skips a Story that can never start and keeps going', async () => {
    qa.startQaBatch = refuses('no target repository resolvable for the work item');
    (service as unknown as { qa: unknown }).qa = qa;

    const view = await service.enqueue(projectId, ['413', '414'], user);

    expect(view.status).not.toBe(DevQueueStatus.Halted);
    expect(view.items.every((i) => i.state === DevQueueItemState.Failed)).toBe(true);
    expect(qa.startQaBatch).toHaveBeenCalledTimes(2); // it tried the second one too
  });

  /** Skipping is only an improvement if the board can still say why. */
  it('records the reason on the Story it skipped', async () => {
    qa.startQaBatch = refuses('no target repository resolvable for the work item');
    (service as unknown as { qa: unknown }).qa = qa;

    const view = await service.enqueue(projectId, ['413'], user);
    expect(view.items[0].note).toContain('no target repository resolvable');
  });

  /** One unstartable Story must not block a startable one queued behind it. */
  it('starts the Story behind the one it skipped', async () => {
    qa.startQaBatch = jest
      .fn()
      .mockImplementationOnce((_p: string, opts: { workItemIds: string[] }) =>
        Promise.resolve({
          dispatched: [],
          skippedActive: [],
          ineligible: [{ workItemId: opts.workItemIds[0], reason: 'no target repository' }],
          deferred: [],
          candidates: 1,
          dryRun: false,
        }),
      )
      .mockImplementation((_p: string, opts: { workItemIds: string[] }) =>
        Promise.resolve({
          dispatched: [
            { runId: 'run-9', workItemId: opts.workItemIds[0], title: 't', kind: 'story' as const },
          ],
          skippedActive: [],
          ineligible: [],
          deferred: [],
          candidates: 1,
          dryRun: false,
        }),
      );
    (service as unknown as { qa: unknown }).qa = qa;

    const view = await service.enqueue(projectId, ['413', '414'], user);

    expect(view.items[0].state).toBe(DevQueueItemState.Failed);
    expect(view.items[1].state).toBe(DevQueueItemState.Running);
    expect(view.items[1].runId).toBe('run-9');
  });

  it('appends a later selection instead of replacing the queue', async () => {
    await service.enqueue(projectId, ['413'], user);
    const view = await service.enqueue(projectId, ['414'], user);
    expect(view.items.map((i) => i.workItemId)).toEqual(['413', '414']);
  });

  it('ignores a duplicate selection of something already queued', async () => {
    await service.enqueue(projectId, ['413', '414'], user);
    const view = await service.enqueue(projectId, ['414'], user);
    expect(view.items.map((i) => i.workItemId)).toEqual(['413', '414']);
  });

  it('drops what is waiting on cancel, and leaves the run in flight alone', async () => {
    await service.enqueue(projectId, ['413', '414', '415'], user);
    const view = await service.cancel(projectId);
    expect(view.items.map((i) => i.workItemId)).toEqual(['413']);
    expect(view.items[0].state).toBe(DevQueueItemState.Running);
  });

  /** A run from the Development queue, or a single "Start testing", must pass straight through. */
  it('ignores a run that belongs to no QA queue', async () => {
    await expect(service.onRunFinished('some-other-run', 'completed')).resolves.toBeUndefined();
  });

  it('reports an empty queue for a project that has none', async () => {
    const view = await service.view(new mongoose.Types.ObjectId().toString());
    expect(view.items).toEqual([]);
    expect(view.status).toBe(DevQueueStatus.Finished);
  });

  it('finishes once every Story has been tested', async () => {
    await service.enqueue(projectId, ['413'], user);
    await service.onRunFinished('run-1', 'completed');
    expect((await service.view(projectId)).status).toBe(DevQueueStatus.Finished);
  });
});

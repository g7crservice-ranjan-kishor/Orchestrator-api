import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Model } from 'mongoose';
import { DevQueueService } from './dev-queue.service';
import {
  DevQueue,
  DevQueueDocument,
  DevQueueItemState,
  DevQueueSchema,
  DevQueueStatus,
} from './schemas/dev-queue.schema';
import { TaskTransitionService } from './task-transition.service';
import { JobsService } from '../jobs/jobs.service';
import { AppConfigService } from '../common/config/app-config.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/**
 * The queue against real persistence, because the promise being made is about durability: a
 * selection has to survive the request that created it, and a refresh has to show the same order.
 *
 * The transition service is stubbed — it is the *existing* mechanism, covered by its own tests.
 * What matters here is that the queue calls it, once, for the right Task, and never overlaps runs.
 */
describe('DevQueueService (in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let model: Model<DevQueueDocument>;
  let service: DevQueueService;
  let transitions: { transition: jest.Mock };
  let jobs: { countActive: jest.Mock };
  const projectId = new mongoose.Types.ObjectId().toString();
  const user = { userId: 'u1', email: 'dev@example.com' } as AuthenticatedUser;

  /** A transition that starts the Task, as the real one does when everything is eligible. */
  const starts = (runId: string) =>
    jest.fn().mockImplementation((_p: string, keys: string[]) =>
      Promise.resolve({
        outcomes: [{ taskKey: keys[0], ok: true, status: 'succeeded', runId }],
      }),
    );

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    model = mongoose.model(DevQueue.name, DevQueueSchema) as unknown as Model<DevQueueDocument>;
  });

  beforeEach(async () => {
    await model.deleteMany({});
    transitions = { transition: starts('run-1') };
    jobs = { countActive: jest.fn().mockResolvedValue(0) };
    service = new DevQueueService(
      model,
      jobs as unknown as JobsService,
      { maxConcurrentRuns: 1 } as AppConfigService,
      transitions as unknown as TaskTransitionService,
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('starts the first Task and leaves the rest waiting, in order', async () => {
    const view = await service.enqueue(projectId, ['201', '202', '203'], user);

    expect(transitions.transition).toHaveBeenCalledTimes(1);
    expect(transitions.transition.mock.calls[0][1]).toEqual(['201']);
    expect(view.items.map((i) => [i.workItemId, i.state])).toEqual([
      ['201', DevQueueItemState.Running],
      ['202', DevQueueItemState.Queued],
      ['203', DevQueueItemState.Queued],
    ]);
  });

  /** The existing mechanism, untouched: the board's own transition does the ADO move and dispatch. */
  it('drives the Task through the board transition, not a second dispatch path', async () => {
    await service.enqueue(projectId, ['201'], user);
    const [, keys, to, actor, opts] = transitions.transition.mock.calls[0];
    expect(keys).toEqual(['201']);
    expect(to).toBe('In Progress');
    expect(actor.email).toBe('dev@example.com'); // attributed to whoever queued it
    expect(opts).toEqual({ source: 'bulk' });
  });

  it('survives a reload: the order is read back from the database', async () => {
    await service.enqueue(projectId, ['201', '202'], user);
    const fresh = new DevQueueService(
      model,
      jobs as unknown as JobsService,
      { maxConcurrentRuns: 1 } as AppConfigService,
      transitions as unknown as TaskTransitionService,
    );
    const view = await fresh.view(projectId);
    expect(view.items.map((i) => i.workItemId)).toEqual(['201', '202']);
    expect(view.status).toBe(DevQueueStatus.Active);
  });

  it('starts the next Task only once the previous run completes', async () => {
    await service.enqueue(projectId, ['201', '202'], user);
    expect(transitions.transition).toHaveBeenCalledTimes(1);

    // While the first is still running, nothing else may start.
    jobs.countActive.mockResolvedValue(1);
    await service.drain(projectId);
    expect(transitions.transition).toHaveBeenCalledTimes(1);

    jobs.countActive.mockResolvedValue(0);
    transitions.transition = starts('run-2');
    (service as unknown as { transitions: unknown }).transitions = transitions;
    await service.onRunFinished('run-1', 'completed');

    expect(transitions.transition).toHaveBeenCalledTimes(1);
    expect(transitions.transition.mock.calls[0][1]).toEqual(['202']);
    const view = await service.view(projectId);
    expect(view.items.map((i) => i.state)).toEqual([
      DevQueueItemState.Done,
      DevQueueItemState.Running,
    ]);
  });

  /** A later Task usually builds on the one that broke. */
  it('halts on a failed run and leaves the remaining Tasks queued', async () => {
    await service.enqueue(projectId, ['201', '202'], user);
    await service.onRunFinished('run-1', 'failed');

    const view = await service.view(projectId);
    expect(view.status).toBe(DevQueueStatus.Halted);
    expect(view.haltedReason).toContain('201');
    expect(view.items[0].state).toBe(DevQueueItemState.Failed);
    expect(view.items[1].state).toBe(DevQueueItemState.Queued);
    expect(transitions.transition).toHaveBeenCalledTimes(1); // nothing new started
  });

  /**
   * Resume retries the Task that broke, before the work that comes after it.
   *
   * It used to leave the failed item marked `failed` and start the next one instead. Dispatch only
   * picks up `queued` items, so the failed Task was skipped for good and every later Task was
   * built on the gap it left — which is the exact thing halting was supposed to prevent.
   */
  it('retries the failed Task first when a halted queue is resumed', async () => {
    await service.enqueue(projectId, ['201', '202'], user);
    await service.onRunFinished('run-1', 'failed');

    transitions.transition = starts('run-2');
    (service as unknown as { transitions: unknown }).transitions = transitions;
    const view = await service.resume(projectId);

    expect(view.status).toBe(DevQueueStatus.Active);
    expect(transitions.transition.mock.calls[0][1]).toEqual(['201']);
    expect(view.items[0].state).toBe(DevQueueItemState.Running);
    expect(view.items[1].state).toBe(DevQueueItemState.Queued);
  });

  /** The retry is a fresh run: the old run's id must not linger on the item. */
  it('clears the failed run from the item it retries', async () => {
    await service.enqueue(projectId, ['201', '202'], user);
    await service.onRunFinished('run-1', 'failed');

    transitions.transition = starts('run-2');
    (service as unknown as { transitions: unknown }).transitions = transitions;
    const view = await service.resume(projectId);

    expect(view.items[0].runId).toBe('run-2');
  });

  /**
   * A Task that can never start is stepped over, not spun on — and does not stop the wave.
   *
   * It used to halt the whole queue. One badly set-up Task then held up everything behind it, for a
   * reason nobody could see from the board.
   */
  it('steps over a Task that can never start, and records why', async () => {
    transitions.transition = jest.fn().mockResolvedValue({
      outcomes: [
        { taskKey: '201', ok: false, status: 'blocked', reason: 'Sprint is in the future' },
      ],
    });
    (service as unknown as { transitions: unknown }).transitions = transitions;

    const view = await service.enqueue(projectId, ['201', '202'], user);
    expect(view.status).not.toBe(DevQueueStatus.Halted);
    expect(view.items[0].state).toBe(DevQueueItemState.Failed);
    expect(view.items[0].note).toContain('Sprint is in the future');
  });

  /**
   * A Task waiting for work it depends on is a different thing entirely: it will become startable
   * on its own, so it stays **Queued** and the queue simply moves past it for now.
   */
  it('leaves a Task waiting on a dependency queued, and starts the one behind it', async () => {
    transitions.transition = jest.fn().mockImplementation((_p: string, keys: string[]) =>
      Promise.resolve({
        outcomes: [
          keys[0] === '201'
            ? {
                taskKey: '201',
                ok: false,
                status: 'blocked',
                reason:
                  'Task 201 is waiting for work that is not finished: #790 "Settings page" ' +
                  '(To Do). It will start on its own once that is Done.',
              }
            : { taskKey: keys[0], ok: true, runId: 'run-7' },
        ],
      }),
    );
    (service as unknown as { transitions: unknown }).transitions = transitions;

    const view = await service.enqueue(projectId, ['201', '202'], user);

    expect(view.status).not.toBe(DevQueueStatus.Halted);
    // Still queued: it comes back on its own once the blocker is Done.
    expect(view.items[0].state).toBe(DevQueueItemState.Queued);
    expect(view.items[0].note).toContain('#790');
    expect(view.items[1].state).toBe(DevQueueItemState.Running);
    expect(view.items[1].runId).toBe('run-7');
  });

  it('appends a later selection instead of replacing the queue', async () => {
    await service.enqueue(projectId, ['201'], user);
    jobs.countActive.mockResolvedValue(1); // the first is running, so nothing new starts
    const view = await service.enqueue(projectId, ['202', '201'], user);

    expect(view.items.map((i) => i.workItemId)).toEqual(['201', '202']); // no duplicate
    expect(transitions.transition).toHaveBeenCalledTimes(1);
  });

  it('cancels what is waiting without touching the run in flight', async () => {
    await service.enqueue(projectId, ['201', '202', '203'], user);
    const view = await service.cancel(projectId);
    expect(view.items.map((i) => i.workItemId)).toEqual(['201']);
    expect(view.items[0].state).toBe(DevQueueItemState.Running);
  });

  it('ignores a run that belongs to no queue', async () => {
    await expect(service.onRunFinished('unrelated-run', 'completed')).resolves.toBeUndefined();
  });
});

import { applyRunOutcome, mergeSelection, nextToDispatch } from './dev-queue.decisions';
import { DevQueueItemState, DevQueueStatus } from './schemas/dev-queue.schema';

const item = (
  workItemId: string,
  position: number,
  state: DevQueueItemState,
  runId: string | null = null,
) => ({ workItemId, position, state, runId });

const queue = (items: ReturnType<typeof item>[], status = DevQueueStatus.Active) => ({
  status,
  items,
});

/**
 * The sequencing rules, decided without a database or a cluster.
 *
 * What matters here is mostly the negative space: the four separate reasons nothing should start.
 * Getting any of them wrong means two agents in one repository, or a queue that quietly stalls.
 */
describe('nextToDispatch', () => {
  const capacity = { capacity: 1 };

  it('hands over the earliest queued Task, in the order the user selected', () => {
    const q = queue([
      item('203', 2, DevQueueItemState.Queued),
      item('201', 0, DevQueueItemState.Queued),
      item('202', 1, DevQueueItemState.Queued),
    ]);
    expect(nextToDispatch(q, capacity)).toBe('201');
  });

  /** One at a time: the whole point of the queue. */
  it('starts nothing while an item is running', () => {
    const q = queue([
      item('201', 0, DevQueueItemState.Running, 'run-1'),
      item('202', 1, DevQueueItemState.Queued),
    ]);
    expect(nextToDispatch(q, capacity)).toBeNull();
  });

  it('starts nothing when the concurrency cap has no room', () => {
    const q = queue([item('201', 0, DevQueueItemState.Queued)]);
    expect(nextToDispatch(q, { capacity: 0 })).toBeNull();
  });

  it('starts nothing while halted, so a failure is not stepped over', () => {
    const q = queue([item('202', 1, DevQueueItemState.Queued)], DevQueueStatus.Halted);
    expect(nextToDispatch(q, capacity)).toBeNull();
  });

  it('starts nothing when there is no queue at all', () => {
    expect(nextToDispatch(null, capacity)).toBeNull();
  });

  it('moves past items that already ran', () => {
    const q = queue([
      item('201', 0, DevQueueItemState.Done, 'run-1'),
      item('202', 1, DevQueueItemState.Queued),
    ]);
    expect(nextToDispatch(q, capacity)).toBe('202');
  });
});

describe('applyRunOutcome', () => {
  const running = () =>
    queue([
      item('201', 0, DevQueueItemState.Running, 'run-1'),
      item('202', 1, DevQueueItemState.Queued),
    ]);

  it('marks the finished item done and leaves the queue feeding', () => {
    const next = applyRunOutcome(running(), 'run-1', 'completed');
    expect(next.items[0].state).toBe(DevQueueItemState.Done);
    expect(next.status).toBe(DevQueueStatus.Active);
    expect(nextToDispatch({ ...next }, { capacity: 1 })).toBe('202');
  });

  /** A later Task usually builds on the one that broke, so carrying on would bury the failure. */
  it('halts the queue on a failure and names the Task that caused it', () => {
    const next = applyRunOutcome(running(), 'run-1', 'failed');
    expect(next.items[0].state).toBe(DevQueueItemState.Failed);
    expect(next.status).toBe(DevQueueStatus.Halted);
    expect(next.haltedReason).toContain('201');
    expect(nextToDispatch({ ...next }, { capacity: 1 })).toBeNull();
  });

  it('finishes the queue once nothing is left to run', () => {
    const q = queue([item('201', 0, DevQueueItemState.Running, 'run-1')]);
    expect(applyRunOutcome(q, 'run-1', 'completed').status).toBe(DevQueueStatus.Finished);
  });

  it('ignores a run that belongs to no item', () => {
    const next = applyRunOutcome(running(), 'someone-elses-run', 'completed');
    expect(next.items.map((i) => i.state)).toEqual([
      DevQueueItemState.Running,
      DevQueueItemState.Queued,
    ]);
  });
});

describe('mergeSelection', () => {
  it('appends new Tasks after the ones already queued', () => {
    const merged = mergeSelection(
      [item('201', 0, DevQueueItemState.Done, 'run-1')],
      ['202', '203'],
    );
    expect(merged.map((i) => [i.workItemId, i.position])).toEqual([
      ['201', 0],
      ['202', 1],
      ['203', 2],
    ]);
  });

  /** Selecting a Task twice must not queue it twice. */
  it('ignores Tasks the queue already holds', () => {
    const merged = mergeSelection([item('201', 0, DevQueueItemState.Queued)], ['201', '202']);
    expect(merged.map((i) => i.workItemId)).toEqual(['201', '202']);
  });

  it('starts from zero for an empty queue', () => {
    expect(mergeSelection([], ['201', '202']).map((i) => i.position)).toEqual([0, 1]);
  });
});

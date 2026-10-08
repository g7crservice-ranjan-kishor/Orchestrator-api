import { DevQueueItemState, DevQueueStatus } from './schemas/dev-queue.schema';

/** The shape the decision functions need — a stored queue, or anything resembling one. */
export interface QueueLike {
  status: DevQueueStatus;
  items: { workItemId: string; position: number; state: DevQueueItemState; runId: string | null }[];
}

/**
 * Which Task the queue should hand to the Developer next, if any.
 *
 * Pure so the sequencing can be reasoned about without a database, a cluster or a clock — the part
 * worth being certain of is *when nothing should start*, and that is four separate conditions.
 */
export function nextToDispatch(
  queue: QueueLike | null,
  opts: { capacity: number; skip?: ReadonlySet<string> },
): string | null {
  if (!queue || queue.status !== DevQueueStatus.Active) {
    return null; // finished, or halted by a failure and waiting for a person
  }
  if (opts.capacity <= 0) {
    return null; // the concurrency cap owns this decision, not the queue
  }
  if (queue.items.some((item) => item.state === DevQueueItemState.Running)) {
    return null; // one at a time: never overlap the run already in flight
  }
  /*
   * `skip` holds what this pass has already tried and found not ready **yet** — a Task waiting for
   * work it depends on. Those stay Queued, because they will become startable on their own once the
   * blocker reaches Done; they are simply stepped over for now, so one waiting Task does not stop
   * the Tasks behind it that could run today.
   */
  const next = [...queue.items]
    .filter((item) => item.state === DevQueueItemState.Queued && !opts.skip?.has(item.workItemId))
    .sort((a, b) => a.position - b.position)[0];
  return next?.workItemId ?? null;
}

/**
 * What a finished run does to the queue.
 *
 * A failure **halts** rather than skipping ahead: the remaining Tasks usually depend on the one
 * that broke, and quietly carrying on would bury the failure under later work. The queue keeps its
 * order so a person can fix the cause and resume.
 */
export function applyRunOutcome(
  queue: QueueLike,
  runId: string,
  outcome: 'completed' | 'failed',
  /**
   * How to word a halt. The QA queue drains Stories rather than Tasks and stops for a different
   * reason, so the sentence is the caller's; the sequencing rules are shared and must not fork.
   */
  opts: { haltMessage?: (workItemId: string) => string } = {},
): { items: QueueLike['items']; status: DevQueueStatus; haltedReason: string | null } {
  const items = queue.items.map((item) =>
    item.runId === runId
      ? {
          ...item,
          state: outcome === 'completed' ? DevQueueItemState.Done : DevQueueItemState.Failed,
        }
      : item,
  );

  if (outcome === 'failed') {
    const failed = items.find((item) => item.runId === runId);
    const workItemId = failed?.workItemId ?? '';
    const halt =
      opts.haltMessage ??
      ((id: string) =>
        `Task ${id} failed. The queue is paused so the remaining Tasks do not build on it.`);
    return { items, status: DevQueueStatus.Halted, haltedReason: halt(workItemId).trim() };
  }

  const done = items.every(
    (item) => item.state === DevQueueItemState.Done || item.state === DevQueueItemState.Failed,
  );
  return {
    items,
    status: done ? DevQueueStatus.Finished : queue.status,
    haltedReason: null,
  };
}

/** Adds a selection to an existing queue, ignoring Tasks it already holds and keeping the order. */
export function mergeSelection(
  existing: QueueLike['items'],
  workItemIds: string[],
): QueueLike['items'] {
  const known = new Set(existing.map((item) => item.workItemId));
  let position = existing.reduce((max, item) => Math.max(max, item.position), -1);
  const added = workItemIds
    .filter((id) => !known.has(id))
    .map((workItemId) => ({
      workItemId,
      position: ++position,
      state: DevQueueItemState.Queued,
      runId: null,
    }));
  return [...existing, ...added];
}

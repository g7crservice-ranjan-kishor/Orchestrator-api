import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../common/config/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { applyRunOutcome, mergeSelection, nextToDispatch, QueueLike } from './dev-queue.decisions';
import {
  DevQueue,
  DevQueueDocument,
  DevQueueItemState,
  DevQueueStatus,
} from './schemas/dev-queue.schema';
import { TaskTransitionService } from './task-transition.service';
import { isWaitingReason } from './blocking-dependencies';

/** One entry as the board shows it. */
export interface DevQueueItemView {
  workItemId: string;
  position: number;
  state: DevQueueItemState;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Why it is waiting, or why it was stepped over; null otherwise. */
  note: string | null;
}

export interface DevQueueView {
  batchId: string;
  status: DevQueueStatus;
  haltedReason: string | null;
  items: DevQueueItemView[];
}

/**
 * Remembers an ordered selection of Tasks and feeds it to the existing Developer path one run at a
 * time.
 *
 * Deliberately **not** a second execution engine. Dispatch, Azure DevOps state, Git and logs are
 * untouched — every start still goes through {@link DevelopmentService.startDevelopmentForTasks},
 * exactly as a single click does. What this adds is memory: before, the Tasks the concurrency cap
 * deferred were reported once and forgotten, so a person had to click again after every run. Now
 * they are recorded in order and the next one starts when a run finishes.
 */
@Injectable()
export class DevQueueService {
  private readonly logger = new Logger(DevQueueService.name);

  constructor(
    @InjectModel(DevQueue.name) private readonly queueModel: Model<DevQueueDocument>,
    private readonly jobs: JobsService,
    private readonly config: AppConfigService,
    private readonly transitions: TaskTransitionService,
  ) {}

  private async active(projectId: string): Promise<DevQueueDocument | null> {
    return this.queueModel
      .findOne({
        projectId: new Types.ObjectId(projectId),
        status: { $in: [DevQueueStatus.Active, DevQueueStatus.Halted] },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * A plain snapshot for the decision functions.
   *
   * Mongoose subdocuments do not survive being spread — `{ ...subdoc }` copies internals, not the
   * schema fields — so handing them straight to the pure helpers silently produced items with no
   * `workItemId` and no `runId`, and the queue never advanced. Converting at the boundary keeps
   * the helpers free of that trap.
   */
  private static snapshot(queue: DevQueueDocument): QueueLike {
    return {
      status: queue.status,
      items: queue.items.map((item) => ({
        workItemId: item.workItemId,
        position: item.position,
        state: item.state,
        runId: item.runId,
      })),
    };
  }

  /**
   * Records a selection and starts the first Task. Adding to a queue that is already running
   * appends rather than replacing, so a second selection extends the run order instead of
   * competing with it.
   */
  async enqueue(
    projectId: string,
    workItemIds: string[],
    user?: AuthenticatedUser | null,
  ): Promise<DevQueueView> {
    const ids = [...new Set(workItemIds.map((id) => String(id).trim()).filter(Boolean))];
    let queue = await this.active(projectId);

    if (!queue) {
      queue = new this.queueModel({
        projectId: new Types.ObjectId(projectId),
        batchId: randomUUID(),
        items: [],
        status: DevQueueStatus.Active,
        actorId: user?.userId ?? null,
        actorEmail: user?.email ?? 'system',
      });
    }

    queue.items = mergeSelection(DevQueueService.snapshot(queue).items, ids) as typeof queue.items;
    // A new selection revives a queue a failure had stopped: the person is asking for more work.
    if (queue.status !== DevQueueStatus.Active) {
      queue.status = DevQueueStatus.Active;
      queue.haltedReason = null;
    }
    await queue.save();

    await this.drain(projectId);
    return this.view(projectId);
  }

  /** How many Tasks one drain steps over before handing the loop back. */
  private static readonly MAX_PASSES = 200;

  /**
   * Starts the next Task the queue and the concurrency cap allow. Safe to call as often as anything
   * likes — a no-op unless a slot is genuinely free.
   *
   * Two kinds of "cannot start" are handled differently, and the difference matters:
   *
   * - **Not yet.** A Task waiting for work it depends on — "add a dark mode toggle to the Settings
   *   page" while the Settings page is still To Do. It stays **Queued** and is stepped over, so the
   *   Tasks behind it that *can* run today still run. It starts on its own once the blocker is Done.
   * - **Not ever.** Anything else: the Task is marked terminal with the reason, and the wave
   *   carries on. It used to halt the whole queue, which meant one badly set-up Task stopped
   *   everything behind it for no reason anybody could see.
   *
   * A run that *fails* is a different question again, and still halts — see `applyRunOutcome`.
   */
  async drain(projectId: string): Promise<void> {
    const waiting = new Set<string>();
    for (let pass = 0; pass < DevQueueService.MAX_PASSES; pass += 1) {
      const outcome = await this.startNext(projectId, waiting);
      if (outcome !== 'skipped') return;
    }
    this.logger.warn(
      `Development queue for project ${projectId} stepped over ` +
        `${DevQueueService.MAX_PASSES} Tasks in one pass; stopping to avoid spinning.`,
    );
  }

  /** One attempt: `started`, `idle` (nothing to do), or `skipped` (try the next one). */
  private async startNext(
    projectId: string,
    waiting: Set<string>,
  ): Promise<'started' | 'idle' | 'skipped'> {
    const queue = await this.active(projectId);
    if (!queue) return 'idle';

    const capacity = this.config.maxConcurrentRuns - (await this.jobs.countActive());
    const workItemId = nextToDispatch(DevQueueService.snapshot(queue), {
      capacity,
      skip: waiting,
    });
    if (!workItemId) return 'idle';

    /*
     * Goes through the board's own transition, not straight to dispatch. That one call is the
     * whole existing mechanism — the eligibility rules, the pod, the Azure DevOps move to
     * In Progress, the Story roll-up and the audit entry. Calling the dispatcher directly would
     * start a pod while leaving the Task sitting in To Do.
     *
     * The queue acts for the person who created it, long after their request ended; only the id
     * and the email are used, to attribute the audit entry to them rather than to "system".
     */
    const result = await this.transitions.transition(
      projectId,
      [workItemId],
      'In Progress',
      {
        userId: queue.actorId ?? '',
        email: queue.actorEmail,
        roles: [],
        sessionId: '',
      } as AuthenticatedUser,
      { source: 'bulk' },
    );
    const outcome = result.outcomes.find((o) => o.taskKey === workItemId);

    const item = queue.items.find((entry) => entry.workItemId === workItemId);
    if (!item) return 'idle';

    if (outcome?.ok && outcome.runId) {
      item.state = DevQueueItemState.Running;
      item.runId = outcome.runId;
      item.startedAt = new Date();
      item.note = null;
      await queue.save();
      return 'started';
    }

    // Not yet: leave it Queued and come back to it. It becomes startable on its own.
    if (isWaitingReason(outcome?.reason)) {
      item.note = outcome?.reason ?? null;
      waiting.add(workItemId);
      await queue.save();
      return 'skipped';
    }

    // Not ever: record the dispatcher's own reason and move on to the rest of the wave.
    item.state = DevQueueItemState.Failed;
    item.finishedAt = new Date();
    item.note = `Could not start: ${outcome?.reason ?? 'the Task could not be started.'}`;
    this.logger.warn(`Development queue skipped ${workItemId} for ${projectId}: ${item.note}`);
    await queue.save();
    return 'skipped';
  }

  /**
   * Called when a run reaches a terminal state. Advances the queue, or halts it if the run failed.
   * Best-effort by design: the queue must never break run ingest.
   */
  async onRunFinished(runId: string, outcome: 'completed' | 'failed'): Promise<void> {
    try {
      const queue = await this.queueModel
        .findOne({ 'items.runId': runId, status: { $in: [DevQueueStatus.Active] } })
        .exec();
      if (!queue) return;

      const next = applyRunOutcome(DevQueueService.snapshot(queue), runId, outcome);
      for (const item of queue.items) {
        const updated = next.items.find((candidate) => candidate.workItemId === item.workItemId);
        if (updated && updated.state !== item.state) {
          item.state = updated.state;
          item.finishedAt = new Date();
        }
      }
      queue.status = next.status;
      queue.haltedReason = next.haltedReason;
      await queue.save();

      if (queue.status === DevQueueStatus.Active) {
        await this.drain(queue.projectId.toString());
      }
    } catch (err) {
      this.logger.error(`Queue could not advance after run ${runId}: ${(err as Error).message}`);
    }
  }

  /**
   * Restarts a queue a failure stopped, **retrying what failed first**.
   *
   * Resume used to leave the failed item marked `failed`, and dispatch only picks up `queued`
   * items — so the Task that broke was skipped and every later Task was built on the gap it
   * left. Returning it to `queued` puts it back in the running: it keeps its original
   * `position`, so it is dispatched before the work that depends on it, which is the whole
   * reason the queue halted in the first place.
   */
  async resume(projectId: string): Promise<DevQueueView> {
    const queue = await this.active(projectId);
    if (!queue) {
      throw new NotFoundException('No development queue for this project.');
    }
    for (const item of queue.items) {
      if (item.state !== DevQueueItemState.Failed) continue;
      item.state = DevQueueItemState.Queued;
      item.runId = null;
      item.startedAt = null;
      item.finishedAt = null;
    }
    queue.status = DevQueueStatus.Active;
    queue.haltedReason = null;
    await queue.save();
    await this.drain(projectId);
    return this.view(projectId);
  }

  /** Drops everything still waiting. A run already in flight is left to finish on its own. */
  async cancel(projectId: string): Promise<DevQueueView> {
    const queue = await this.active(projectId);
    if (queue) {
      queue.items = queue.items.filter(
        (item) => item.state !== DevQueueItemState.Queued,
      ) as typeof queue.items;
      // Only close the queue once nothing is running — otherwise the board would stop showing the
      // Task that is still executing, and the completion hook would have no queue to land on.
      const running = queue.items.some((item) => item.state === DevQueueItemState.Running);
      queue.status = running ? DevQueueStatus.Active : DevQueueStatus.Finished;
      queue.haltedReason = null;
      await queue.save();
    }
    return this.view(projectId);
  }

  /** The queue as the board renders it. Empty when nothing has been queued for this project. */
  async view(projectId: string): Promise<DevQueueView> {
    const queue = await this.active(projectId);
    if (!queue) {
      return { batchId: '', status: DevQueueStatus.Finished, haltedReason: null, items: [] };
    }
    return {
      batchId: queue.batchId,
      status: queue.status,
      haltedReason: queue.haltedReason,
      items: [...queue.items]
        .sort((a, b) => a.position - b.position)
        .map((item) => ({
          workItemId: item.workItemId,
          position: item.position,
          state: item.state,
          runId: item.runId,
          startedAt: item.startedAt?.toISOString() ?? null,
          finishedAt: item.finishedAt?.toISOString() ?? null,
          note: item.note ?? null,
        })),
    };
  }
}

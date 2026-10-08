import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../common/config/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import {
  applyRunOutcome,
  mergeSelection,
  nextToDispatch,
  QueueLike,
} from '../development/dev-queue.decisions';
import { DevQueueItemState, DevQueueStatus } from '../development/schemas/dev-queue.schema';
import { QaQueue, QaQueueDocument } from './schemas/qa-queue.schema';
import { QaService } from './qa.service';

/** One entry as the board shows it. */
export interface QaQueueItemView {
  workItemId: string;
  position: number;
  state: DevQueueItemState;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Why a skipped Story was passed over; null for everything else. */
  note: string | null;
}

export interface QaQueueView {
  batchId: string;
  status: DevQueueStatus;
  haltedReason: string | null;
  items: QaQueueItemView[];
}

/**
 * Remembers an ordered selection of Stories and feeds it to the existing QA path one run at a time.
 *
 * The gap this closes: `startQaBatch` dispatches only as many items as the concurrency cap allows
 * and returns the rest as `deferred`. The scheduler written to drain that list is off by default,
 * so selecting twenty Stories started one and forgot nineteen — with nothing on screen to say so.
 *
 * Deliberately not a second execution engine. Every start still goes through
 * {@link QaService.startQaBatch}, so eligibility, idempotency, the repo tag and the concurrency cap
 * behave exactly as they do for a single click. What this adds is memory, and a next step.
 */
@Injectable()
export class QaQueueService {
  private readonly logger = new Logger(QaQueueService.name);

  constructor(
    @InjectModel(QaQueue.name) private readonly queueModel: Model<QaQueueDocument>,
    private readonly jobs: JobsService,
    private readonly config: AppConfigService,
    private readonly qa: QaService,
  ) {}

  /** Why a QA queue stops. Stories are independent, but a failure is usually systemic. */
  private static haltMessage(workItemId: string): string {
    return (
      `Story ${workItemId} could not be tested. The queue is paused so the rest are not ` +
      'spent failing the same way.'
    ).trim();
  }

  private async active(projectId: string): Promise<QaQueueDocument | null> {
    return this.queueModel
      .findOne({
        projectId: new Types.ObjectId(projectId),
        status: { $in: [DevQueueStatus.Active, DevQueueStatus.Halted] },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * A plain snapshot for the shared decision functions. Mongoose subdocuments do not survive being
   * spread, so they are converted at the boundary — the same trap that once left the Development
   * queue with items carrying no `workItemId` and no `runId`, silently never advancing.
   */
  private static snapshot(queue: QaQueueDocument): QueueLike {
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
   * Records a selection and starts the first Story. Adding to a queue that is already running
   * appends rather than replacing, so a second selection extends the order instead of racing it.
   */
  async enqueue(
    projectId: string,
    workItemIds: string[],
    user?: AuthenticatedUser | null,
  ): Promise<QaQueueView> {
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

    queue.items = mergeSelection(QaQueueService.snapshot(queue).items, ids) as typeof queue.items;
    // A new selection revives a queue a failure had stopped: the person is asking for more work.
    if (queue.status !== DevQueueStatus.Active) {
      queue.status = DevQueueStatus.Active;
      queue.haltedReason = null;
    }
    await queue.save();

    await this.drain(projectId);
    return this.view(projectId);
  }

  /**
   * Starts the next Story if the queue, and the concurrency cap, both allow it. Safe to call as
   * often as anything likes — a no-op unless a slot is genuinely free.
   *
   * A Story that can never start is **skipped**, and the queue moves on to the next one. It used to
   * halt the whole queue, which conflated two different things: a QA run that *failed* is usually
   * systemic and worth stopping for, but a Story that was never set up properly says nothing at all
   * about the eighteen behind it. One untagged Story paused an entire wave that way.
   */
  async drain(projectId: string): Promise<void> {
    // Each pass starts a Story, finds nothing to do, or skips one that can never start. Bounded by
    // the queue's own length, because a skipped Story is marked terminal before the next pass.
    for (let pass = 0; pass < QaQueueService.MAX_SKIPS_PER_DRAIN; pass += 1) {
      if ((await this.startNext(projectId)) !== 'skipped') return;
    }
    this.logger.warn(
      `QA queue for project ${projectId} skipped ${QaQueueService.MAX_SKIPS_PER_DRAIN} ` +
        'unstartable Stories in one pass; stopping to avoid spinning.',
    );
  }

  /** How many unstartable Stories one drain will step over before giving the loop back. */
  private static readonly MAX_SKIPS_PER_DRAIN = 100;

  /** One attempt: `started`, `idle` (nothing to do or no capacity), or `skipped`. */
  private async startNext(projectId: string): Promise<'started' | 'idle' | 'skipped'> {
    const queue = await this.active(projectId);
    if (!queue) return 'idle';

    const capacity = this.config.maxConcurrentRuns - (await this.jobs.countActive());
    const workItemId = nextToDispatch(QaQueueService.snapshot(queue), { capacity });
    if (!workItemId) return 'idle';

    /*
     * Goes through the ordinary QA start, not straight to dispatch. That one call carries every
     * existing rule — the work item must be a Story or Bug, in the right state, not already
     * verified, with a resolvable repository — and the pod, the run token and the audit entry
     * come with it. Calling the dispatcher directly would bypass all of it.
     */
    const result = await this.qa.startQaBatch(projectId, {
      workItemIds: [workItemId],
      maxDispatch: 1,
    });
    const dispatched = result.dispatched.find((d) => d.workItemId === workItemId);

    const item = queue.items.find((entry) => entry.workItemId === workItemId);
    if (!item) return 'idle';

    if (dispatched?.runId) {
      item.state = DevQueueItemState.Running;
      item.runId = dispatched.runId;
      item.startedAt = new Date();
      await queue.save();
      return 'started';
    }

    if (result.skippedActive.includes(workItemId)) {
      // Already under test from elsewhere — adopt it rather than starting a second run.
      item.state = DevQueueItemState.Running;
      item.startedAt = item.startedAt ?? new Date();
      await queue.save();
      return 'started';
    }

    if (result.deferred.includes(workItemId)) {
      return 'idle'; // no capacity after all; the next run's completion will try again
    }

    // Not startable, ever. The item records the API's own reason so the board can say why this one
    // was passed over, and the wave carries on with the rest.
    const reason = result.ineligible.find((i) => i.workItemId === workItemId)?.reason;
    item.state = DevQueueItemState.Failed;
    item.finishedAt = new Date();
    item.note = `Could not start: ${reason ?? 'it is not eligible for QA.'}`;
    this.logger.warn(`QA queue skipped ${workItemId} for project ${projectId}: ${item.note}`);
    await queue.save();
    return 'skipped';
  }

  /**
   * Called when a run reaches a terminal state. Advances the queue, or halts it if the run failed.
   * Best-effort by design: the queue must never break run ingest, and a run that belongs to no
   * queue (a single "Start testing", or a Developer run) must pass straight through.
   */
  async onRunFinished(runId: string, outcome: 'completed' | 'failed'): Promise<void> {
    try {
      const queue = await this.queueModel
        .findOne({ 'items.runId': runId, status: { $in: [DevQueueStatus.Active] } })
        .exec();
      if (!queue) return;

      const next = applyRunOutcome(QaQueueService.snapshot(queue), runId, outcome, {
        haltMessage: QaQueueService.haltMessage,
      });
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
      this.logger.error(`QA queue could not advance after run ${runId}: ${(err as Error).message}`);
    }
  }

  /**
   * Restarts a queue a failure stopped, **retrying what failed first**. A failed item goes back to
   * queued and keeps its position, so it runs before the Stories behind it rather than being
   * skipped for good.
   */
  async resume(projectId: string): Promise<QaQueueView> {
    const queue = await this.active(projectId);
    if (!queue) {
      throw new NotFoundException('No QA queue for this project.');
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
  async cancel(projectId: string): Promise<QaQueueView> {
    const queue = await this.active(projectId);
    if (queue) {
      queue.items = queue.items.filter(
        (item) => item.state !== DevQueueItemState.Queued,
      ) as typeof queue.items;
      // Only close the queue once nothing is running — otherwise the board would stop showing the
      // Story still under test, and the completion hook would have no queue to land on.
      const running = queue.items.some((item) => item.state === DevQueueItemState.Running);
      queue.status = running ? DevQueueStatus.Active : DevQueueStatus.Finished;
      queue.haltedReason = null;
      await queue.save();
    }
    return this.view(projectId);
  }

  /** The queue as the board renders it. Empty when nothing has been queued for this project. */
  async view(projectId: string): Promise<QaQueueView> {
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

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { findActiveDraft } from '../planning/draft-repository';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { BacklogItemType, Draft, DraftDocument } from '../planning/schemas/draft.schema';
import { AdoClientService } from '../ado/ado-client.service';
import { AdoPushService } from '../ado/ado-push.service';
import { SprintContext, SprintService, SprintTimeFrame } from '../ado/sprint.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuditService } from '../audit/audit.service';
import { StoryRollupService } from './story-rollup.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { JobsService } from '../jobs/jobs.service';
import { ProjectsService } from '../projects/projects.service';
import { DevelopmentService } from './development.service';
import { effectiveRepoTags, resolveExecutionAgent } from './repo-resolution';
import {
  BoardStatus,
  WorkItemKind,
  effectiveBoardStatus,
  validateTaskTransition,
  workItemKindOf,
} from './task-transition-rules';

/**
 * Board statuses a **user** may transition a Task to. `Done` is deliberately absent: only the
 * orchestrator moves a Task to Done, after a successful Developer Agent run
 * ({@link TaskTransitionService.completeTask}).
 */
export type TransitionTarget = 'To Do' | 'In Progress';

/** How the transition was initiated — recorded in the audit trail. */
export type TransitionSource = 'button' | 'drag-drop' | 'bulk';

/**
 * What happened to one Task. `blocked` = a business rule rejected it (future sprint, no execution
 * agent, …); `skipped` = nothing to do (a run was already active); `failed` = it was attempted and
 * errored. Only `succeeded` changed state.
 */
export type OutcomeStatus = 'succeeded' | 'blocked' | 'failed' | 'skipped';

export interface TaskTransitionOutcome {
  /** Board card key: the ADO id when pushed, else the draft backlog item id. */
  taskKey: string;
  adoId: number | null;
  title: string;
  from: string;
  to: string;
  status: OutcomeStatus;
  /** Convenience flag — true only for `succeeded`. */
  ok: boolean;
  /** Why it was blocked/failed, or a caveat on a partial success. */
  reason?: string;
  /** The suggested next step, when there is one. */
  hint?: string;
  /** The Developer run started for this Task (To Do → In Progress only). */
  runId?: string;
  sprint?: string | null;
  executionAgent?: string | null;
}

export interface TaskTransitionResult {
  /** Correlates every Task in one operation (single or bulk) in the audit trail. */
  bulkOperationId: string;
  to: TransitionTarget;
  /** True when this was a validation preview — nothing was changed. */
  dryRun: boolean;
  requested: number;
  succeeded: number;
  blocked: number;
  failed: number;
  skipped: number;
  outcomes: TaskTransitionOutcome[];
}

/** The ADO state each board status writes back to Azure DevOps. */
/**
 * Board status → the **real** Azure DevOps state name, per work-item type. A Task runs
 * `To Do → In Progress → Done`; a Bug runs `New → Committed → Done` (the verified project model,
 * qa-workflow.ts). The board speaks one vocabulary; ADO is written in its own.
 */
const ADO_STATE: Record<'task' | 'bug', Record<'To Do' | 'In Progress' | 'Done', string>> = {
  task: { 'To Do': 'To Do', 'In Progress': 'In Progress', Done: 'Done' },
  bug: { 'To Do': 'New', 'In Progress': 'Committed', Done: 'Done' },
};

/** The ADO state name for a board status, defaulting to the Task vocabulary. */
function adoStateFor(kind: WorkItemKind, status: 'To Do' | 'In Progress' | 'Done'): string {
  return kind === 'bug' ? ADO_STATE.bug[status] : ADO_STATE.task[status];
}

/** Parent Story states that mean "approved for development". */
const APPROVED_PARENT_STATES = new Set(['approved', 'committed', 'done']);

/** The live ADO facts the transition rules need for one Task. */
interface StartContext {
  adoId: number;
  title: string;
  status: BoardStatus;
  kind: WorkItemKind;
  sprint: string | null;
  sprintTimeFrame: SprintTimeFrame;
  executionAgent: string | null;
  hasActiveExecution: boolean;
  parentStoryApproved: boolean | null;
  hasParentStory: boolean;
  /** Current ADO assignee — empty means the transition must supply one (process rule). */
  assignee: string | null;
}

const START_FIELDS = [
  'System.Title',
  'System.State',
  // Without the type every item classifies as a Task, and a Bug is then written the Task state
  // vocabulary (`In Progress`), which Azure DevOps rejects outright — the type drives `adoStateFor`.
  'System.WorkItemType',
  'System.Parent',
  'System.Tags',
  'System.IterationPath',
  'System.AssignedTo',
];

/**
 * Owns every **Task state transition** on the Development board — for a single card, a bulk
 * selection, a drag-and-drop, or a direct API call. All of them run the same centralized rules
 * ({@link validateTaskTransition}), so no path can disagree with another, and every operation is
 * recorded in the immutable audit trail (who, when, which Tasks, source → target, sprint, execution
 * agent, and the per-Task result).
 *
 * Allowed transitions:
 * - `Draft → To Do` — approve Task(s) for development; the Task (plus any missing ancestors) is
 *   created in Azure DevOps via the idempotent push.
 * - `To Do → In Progress` — dispatch Task(s) to the Claude Developer Agent, then write the ADO state.
 * - `In Progress → Done` — **orchestrator only**, after a successful run. Never user-driven.
 *
 * Azure DevOps stays the source of truth; this service writes states there rather than keeping a
 * parallel task store (ARCHITECTURE.md §8).
 */
@Injectable()
export class TaskTransitionService {
  private readonly logger = new Logger(TaskTransitionService.name);

  constructor(
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
    private readonly ado: AdoClientService,
    private readonly push: AdoPushService,
    private readonly development: DevelopmentService,
    private readonly projects: ProjectsService,
    private readonly sprints: SprintService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly storyRollup: StoryRollupService,
  ) {}

  /**
   * Validates (and unless `dryRun`, performs) a transition for one or many Tasks, then audits the
   * operation. `dryRun` backs the bulk confirmation dialog: it reports exactly which Tasks are
   * eligible and why the rest are blocked, without changing anything.
   */
  async transition(
    projectId: string,
    taskKeys: string[],
    to: TransitionTarget,
    user: AuthenticatedUser,
    opts: { dryRun?: boolean; source?: TransitionSource } = {},
  ): Promise<TaskTransitionResult> {
    const keys = [...new Set(taskKeys.map((k) => k.trim()).filter(Boolean))];
    if (keys.length === 0) {
      throw new BadRequestException('Select at least one Task to transition.');
    }
    const dryRun = Boolean(opts.dryRun);
    const source = opts.source ?? 'button';
    const bulkOperationId = randomUUID();

    const outcomes =
      to === 'To Do'
        ? await this.approveForDevelopment(projectId, keys, user, dryRun)
        : await this.startDevelopment(projectId, keys, user, dryRun);

    const result = this.summarize(bulkOperationId, to, dryRun, keys.length, outcomes);

    // A preview changes nothing, so it is not an auditable state transition.
    if (!dryRun) {
      await this.audit.append({
        actor: AuditService.actorFrom(user),
        action: to === 'To Do' ? AuditAction.TaskApproved : AuditAction.TaskDevelopmentStarted,
        entityType: 'project',
        entityId: projectId,
        projectId,
        metadata: {
          bulkOperationId,
          source,
          bulk: keys.length > 1,
          from: to === 'To Do' ? 'Draft' : 'To Do',
          to,
          totalSelected: result.requested,
          succeeded: result.succeeded,
          blocked: result.blocked,
          failed: result.failed,
          skipped: result.skipped,
          tasks: result.outcomes.map((o) => ({
            taskKey: o.taskKey,
            adoId: o.adoId,
            title: o.title,
            from: o.from,
            to: o.to,
            result: o.status,
            reason: o.reason,
            runId: o.runId,
            sprint: o.sprint,
            executionAgent: o.executionAgent,
          })),
        },
      });
      this.logger.log(
        `Task transition → ${to} by ${user.email} via ${source} [${bulkOperationId}]: ` +
          `${result.succeeded} moved, ${result.blocked} blocked, ${result.failed} failed.`,
      );
    }
    return result;
  }

  /**
   * `Draft → To Do`: approve drafted Task(s) by creating them in Azure DevOps (with any missing
   * ancestors). Keys are draft backlog item ids. Each Task is judged independently, and the push
   * persists ids as it goes, so a partial failure still reports accurate per-Task results.
   */
  private async approveForDevelopment(
    projectId: string,
    keys: string[],
    user: AuthenticatedUser,
    dryRun: boolean,
  ): Promise<TaskTransitionOutcome[]> {
    const draft = await this.getDraft(projectId);
    const byId = new Map(draft.backlog.map((i) => [i.id, i]));
    const outcomes: TaskTransitionOutcome[] = [];
    const eligible: string[] = [];

    for (const key of keys) {
      const item = byId.get(key);
      const title = item?.title ?? key;
      const verdict = validateTaskTransition({
        from: 'Draft',
        to: 'To Do',
        inAdo: item?.adoId != null,
        kind: item?.type === BacklogItemType.Task ? 'task' : 'other',
        sprintTimeFrame: 'unknown',
        currentSprint: null,
        taskSprint: item?.sprint ?? null,
        executionAgent: null,
        hasActiveExecution: false,
        parentStoryApproved: null,
        hasParentStory: true,
      });
      if (!item) {
        outcomes.push(this.outcome(key, null, title, 'Draft', 'To Do', 'blocked', 'Unknown Task.'));
      } else if (!verdict.ok) {
        outcomes.push(
          this.outcome(
            key,
            item.adoId ?? null,
            title,
            'Draft',
            'To Do',
            'blocked',
            verdict.reason,
            verdict.hint,
          ),
        );
      } else if (dryRun) {
        outcomes.push(this.outcome(key, null, title, 'Draft', 'To Do', 'succeeded'));
      } else {
        eligible.push(key);
      }
    }

    if (!dryRun && eligible.length > 0) {
      let pushError: string | null = null;
      try {
        await this.push.pushItems(projectId, eligible, user);
      } catch (err) {
        pushError = (err as Error).message;
      }
      // Re-read so each outcome reflects what actually landed in ADO.
      const after = await this.getDraft(projectId);
      const afterById = new Map(after.backlog.map((i) => [i.id, i]));
      for (const key of eligible) {
        const item = afterById.get(key);
        const created = Boolean(item?.adoId);
        outcomes.push(
          this.outcome(
            key,
            item?.adoId ?? null,
            item?.title ?? key,
            'Draft',
            'To Do',
            created ? 'succeeded' : 'failed',
            created ? undefined : (pushError ?? 'Azure DevOps did not create this Task.'),
          ),
        );
      }
    }
    return outcomes;
  }

  /**
   * `To Do → In Progress`: validate every selected Task against the centralized rules (state,
   * sprint, execution agent, active execution, hierarchy), then dispatch only the eligible ones and
   * write the ADO state. Dispatch itself re-applies the existing guards (one active run per Task,
   * repo resolution, concurrency cap) — a Task deferred by the cap is reported, never silently lost.
   */
  private async startDevelopment(
    projectId: string,
    keys: string[],
    user: AuthenticatedUser,
    dryRun: boolean,
  ): Promise<TaskTransitionOutcome[]> {
    const project = await this.projects.findById(projectId);
    const sprintContext = await this.sprints.getContext(
      project.adoTarget.project,
      project.id as string,
    );
    const contexts = await this.buildStartContexts(
      keys,
      project.targetRepos,
      sprintContext,
      project.id as string,
    );

    const outcomes: TaskTransitionOutcome[] = [];
    const eligible: string[] = [];

    for (const key of keys) {
      const c = contexts.get(key);
      if (!c) {
        outcomes.push(
          this.outcome(
            key,
            null,
            key,
            'To Do',
            'In Progress',
            'blocked',
            'This Task is not in Azure DevOps yet.',
            'Approve it for development first (Draft → To Do).',
          ),
        );
        continue;
      }
      const verdict = validateTaskTransition({
        from: c.status,
        to: 'In Progress',
        inAdo: true,
        kind: c.kind,
        sprintTimeFrame: c.sprintTimeFrame,
        currentSprint: sprintContext.currentSprint,
        taskSprint: c.sprint,
        executionAgent: c.executionAgent,
        hasActiveExecution: c.hasActiveExecution,
        parentStoryApproved: c.parentStoryApproved,
        hasParentStory: c.hasParentStory,
      });
      if (!verdict.ok) {
        outcomes.push(
          this.outcome(
            key,
            c.adoId,
            c.title,
            c.status,
            'In Progress',
            c.hasActiveExecution ? 'skipped' : 'blocked',
            verdict.reason,
            verdict.hint,
            undefined,
            c.sprint,
            c.executionAgent,
          ),
        );
      } else if (dryRun) {
        outcomes.push(
          this.outcome(
            key,
            c.adoId,
            c.title,
            'To Do',
            'In Progress',
            'succeeded',
            undefined,
            undefined,
            undefined,
            c.sprint,
            c.executionAgent,
          ),
        );
      } else {
        eligible.push(key);
      }
    }

    if (!dryRun && eligible.length > 0) {
      const dispatch = await this.development.startDevelopmentForTasks(projectId, eligible);
      const describe = (id: string) => contexts.get(id);

      for (const job of dispatch.dispatched) {
        const key = String(job.workItemId);
        const c = describe(key);
        const caveat = await this.markInProgress(
          projectId,
          Number(key),
          job.runId,
          user,
          c?.assignee ?? null,
          c?.kind ?? 'task',
        );
        outcomes.push(
          this.outcome(
            key,
            Number(key),
            c?.title ?? key,
            'To Do',
            'In Progress',
            'succeeded',
            caveat,
            undefined,
            job.runId,
            c?.sprint,
            c?.executionAgent,
          ),
        );
      }
      const note = (key: string, status: OutcomeStatus, reason: string) => {
        const c = describe(key);
        outcomes.push(
          this.outcome(
            key,
            Number(key),
            c?.title ?? key,
            'To Do',
            'In Progress',
            status,
            reason,
            undefined,
            undefined,
            c?.sprint,
            c?.executionAgent,
          ),
        );
      };
      dispatch.skippedActive.forEach((id) =>
        note(id, 'skipped', 'A Developer agent is already running on this Task.'),
      );
      dispatch.ineligible.forEach(({ workItemId, reason }) => note(workItemId, 'blocked', reason));
      dispatch.deferred.forEach((id) =>
        note(
          id,
          'skipped',
          'Deferred — the concurrent-run cap is reached; start it again once a run finishes.',
        ),
      );
    }
    return outcomes;
  }

  /** Gathers the live ADO facts the rules need for each selected Task, in two batched reads. */
  private async buildStartContexts(
    keys: string[],
    targetRepos: string[],
    sprintContext: SprintContext,
    owner: string,
  ): Promise<Map<string, StartContext>> {
    const ids = keys.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const contexts = new Map<string, StartContext>();
    if (ids.length === 0) return contexts;

    const items = await this.ado.for(owner).getWorkItemsBatch(ids, START_FIELDS);
    const parentIds = [
      ...new Set(
        items
          .map((wi) => wi.fields['System.Parent'])
          .filter((p): p is number => typeof p === 'number'),
      ),
    ];
    // Tags come back with the state: a child with no repo tag of its own inherits the parent's.
    const parents = parentIds.length
      ? await this.ado.for(owner).getWorkItemsBatch(parentIds, ['System.State', 'System.Tags'])
      : [];
    const parentState = new Map(
      parents.map((p) => [
        p.id,
        String(p.fields['System.State'] ?? '')
          .trim()
          .toLowerCase(),
      ]),
    );
    const parentTags = new Map(parents.map((p) => [p.id, String(p.fields['System.Tags'] ?? '')]));

    for (const wi of items) {
      const type = String(wi.fields['System.WorkItemType'] ?? 'Task');
      const rawState = String(wi.fields['System.State'] ?? '');
      const iterationPath =
        typeof wi.fields['System.IterationPath'] === 'string'
          ? (wi.fields['System.IterationPath'] as string)
          : null;
      const parentId = wi.fields['System.Parent'];
      const parent = typeof parentId === 'number' ? parentState.get(parentId) : undefined;
      const kind = workItemKindOf(type);
      const hasActiveExecution = Boolean(await this.jobs.findActiveForWorkItem(String(wi.id)));
      contexts.set(String(wi.id), {
        adoId: wi.id,
        title: String(wi.fields['System.Title'] ?? ''),
        // The live run decides, not the state — a Bug QA reopened is To Do, not In Progress.
        status: effectiveBoardStatus(
          kind,
          TaskTransitionService.boardStatusOf(rawState),
          hasActiveExecution,
        ),
        kind,
        sprint: iterationPath ? (iterationPath.split(/[\\/]/).filter(Boolean).pop() ?? null) : null,
        sprintTimeFrame: SprintService.classify(iterationPath, sprintContext),
        executionAgent: resolveExecutionAgent(
          targetRepos,
          effectiveRepoTags(
            String(wi.fields['System.Tags'] ?? ''),
            typeof parentId === 'number' ? parentTags.get(parentId) : null,
          ),
        ),
        hasActiveExecution,
        assignee: TaskTransitionService.identityName(wi.fields['System.AssignedTo']),
        parentStoryApproved: parent === undefined ? null : APPROVED_PARENT_STATES.has(parent),
        hasParentStory: typeof parentId === 'number',
      });
    }
    return contexts;
  }

  /** `System.AssignedTo` is an identity object in REST 7.0 (a plain string on older payloads). */
  private static identityName(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    const id = value as { displayName?: string; uniqueName?: string };
    return id.uniqueName?.trim() || id.displayName?.trim() || null;
  }

  /** The identity the orchestrator assigns work to when a transition requires one. */
  private get developerAssignee(): string | null {
    return process.env.ADO_DEVELOPER_ASSIGNEE?.trim() || null;
  }

  /**
   * Fields a state transition must carry to satisfy this project's process rules. Scrum here makes
   * **Assigned To** required to leave To Do, so an unassigned Task is given the configured developer
   * identity in the same patch (an existing assignee is never overwritten).
   */
  private requiredFieldsFor(currentAssignee: string | null): Record<string, unknown> {
    if (currentAssignee || !this.developerAssignee) return {};
    return { 'System.AssignedTo': this.developerAssignee };
  }

  /** Raw ADO state → board status (same mapping the board projection uses). */
  private static boardStatusOf(state: string): BoardStatus {
    const raw = state.trim().toLowerCase();
    if (['done', 'closed', 'completed', 'resolved'].includes(raw)) return 'Done';
    if (['in progress', 'doing', 'active', 'committed'].includes(raw)) return 'In Progress';
    if (['to do', 'todo', 'new', 'proposed', 'open'].includes(raw)) return 'To Do';
    return 'Draft';
  }

  /** Writes the In Progress state. Returns a caveat when the write failed (the dispatch stands). */
  private async markInProgress(
    projectId: string,
    workItemId: number,
    runId: string,
    user: AuthenticatedUser,
    currentAssignee: string | null,
    kind: WorkItemKind,
  ): Promise<string | undefined> {
    try {
      await this.ado
        .for(projectId)
        .setWorkItemState(
          workItemId,
          adoStateFor(kind, 'In Progress'),
          `Development started by ${user.email} — dispatched to the Claude Developer Agent (run ${runId}).`,
          this.requiredFieldsFor(currentAssignee),
        );
      // Development has begun, so the parent Story is no longer merely Approved (D-028).
      await this.storyRollup.onTaskStarted(projectId, workItemId);
      return undefined;
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(
        `Agent dispatched for Task ${workItemId} but the ADO state write failed: ${reason}`,
      );
      return `Agent dispatched, but the Azure DevOps state could not be set to In Progress: ${reason}`;
    }
  }

  /**
   * **Orchestrator-owned** `In Progress → Done`, called when a Developer run completes
   * successfully. Not reachable from the board API — users can never drive it. Never throws into
   * the run-ingest flow; a failure is logged and audited.
   */
  async completeTask(projectId: string | null, workItemId: string, runId: string): Promise<void> {
    const id = Number(workItemId);
    if (!Number.isInteger(id)) return;

    let ok = true;
    let reason: string | undefined;
    try {
      const [wi] = await this.ado
        .for(projectId)
        .getWorkItemsBatch([id], ['System.AssignedTo', 'System.WorkItemType']);
      const assignee = TaskTransitionService.identityName(wi?.fields['System.AssignedTo']);
      const kind = workItemKindOf(String(wi?.fields['System.WorkItemType'] ?? 'Task'));
      await this.ado
        .for(projectId)
        .setWorkItemState(
          id,
          adoStateFor(kind, 'Done'),
          `Completed by the Claude Developer Agent (run ${runId}) — build and unit tests green.`,
          this.requiredFieldsFor(assignee),
        );
    } catch (err) {
      ok = false;
      reason = (err as Error).message;
      this.logger.error(`Could not move Task ${workItemId} to Done after run ${runId}: ${reason}`);
    }

    await this.audit.append({
      actor: AuditService.actorFrom(null), // orchestrator, not a user
      action: AuditAction.TaskCompleted,
      entityType: 'task',
      entityId: workItemId,
      projectId,
      metadata: {
        from: 'In Progress',
        to: 'Done',
        runId,
        result: ok ? 'succeeded' : 'failed',
        reason,
      },
    });

    // The Task is Done — the Story may now be complete, which is what makes it Ready for QA (D-028).
    if (ok) {
      await this.storyRollup.onTaskCompleted(projectId, id);
    }
  }

  /**
   * Records a **failed** Developer run and returns the Task to `To Do`.
   *
   * It used to be left in `In Progress` on the grounds that "the retry machinery owns
   * recovery". There is no such machinery for a run that genuinely failed — lease reclaim only
   * rescues dead pods — so the Task sat In Progress for ever, and because `startDevelopment`
   * will only start a Task that is in `To Do`, it could not even be retried by hand. Returning
   * it is what makes a retry possible; the comment on the work item, the audit entry and the
   * queue's own `failed` marker are what keep the failure visible.
   */
  async recordExecutionFailure(
    projectId: string | null,
    workItemId: string,
    runId: string,
    reason: string,
  ): Promise<void> {
    const id = Number(workItemId);
    let returned = false;
    let returnFailure: string | undefined;
    if (Number.isInteger(id)) {
      try {
        const [wi] = await this.ado
          .for(projectId)
          .getWorkItemsBatch([id], ['System.AssignedTo', 'System.WorkItemType']);
        const assignee = TaskTransitionService.identityName(wi?.fields['System.AssignedTo']);
        const kind = workItemKindOf(String(wi?.fields['System.WorkItemType'] ?? 'Task'));
        await this.ado
          .for(projectId)
          .setWorkItemState(
            id,
            adoStateFor(kind, 'To Do'),
            `Returned to To Do: the Claude Developer Agent run ${runId} failed. ${reason}`,
            this.requiredFieldsFor(assignee),
          );
        returned = true;
      } catch (err) {
        returnFailure = (err as Error).message;
        this.logger.error(
          `Could not return Task ${workItemId} to To Do after run ${runId}: ${returnFailure}`,
        );
      }
    }

    await this.audit.append({
      actor: AuditService.actorFrom(null),
      action: AuditAction.TaskExecutionFailed,
      entityType: 'task',
      entityId: workItemId,
      projectId,
      metadata: {
        from: 'In Progress',
        to: returned ? 'To Do' : 'In Progress',
        runId,
        result: 'failed',
        reason: returnFailure ? `${reason} (${returnFailure})` : reason,
      },
    });
  }

  private outcome(
    taskKey: string,
    adoId: number | null,
    title: string,
    from: string,
    to: string,
    status: OutcomeStatus,
    reason?: string,
    hint?: string,
    runId?: string,
    sprint?: string | null,
    executionAgent?: string | null,
  ): TaskTransitionOutcome {
    return {
      taskKey,
      adoId,
      title,
      from,
      to,
      status,
      ok: status === 'succeeded',
      reason,
      hint,
      runId,
      sprint,
      executionAgent,
    };
  }

  private summarize(
    bulkOperationId: string,
    to: TransitionTarget,
    dryRun: boolean,
    requested: number,
    outcomes: TaskTransitionOutcome[],
  ): TaskTransitionResult {
    const count = (s: OutcomeStatus) => outcomes.filter((o) => o.status === s).length;
    return {
      bulkOperationId,
      to,
      dryRun,
      requested,
      succeeded: count('succeeded'),
      blocked: count('blocked'),
      failed: count('failed'),
      skipped: count('skipped'),
      outcomes,
    };
  }

  private async getDraft(projectId: string): Promise<DraftDocument> {
    const draft = await findActiveDraft(this.draftModel, projectId);
    if (!draft) {
      throw new NotFoundException('No planning draft for this project.');
    }
    return draft;
  }
}

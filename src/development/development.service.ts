import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { effectiveRepoTags, parseRepoTag, resolveRepo } from './repo-resolution';
import { workItemKindOf } from './task-transition-rules';
import { AppConfigService } from '../common/config/app-config.service';
import { AdoClientService } from '../ado/ado-client.service';
import { EnqueueJobSpec, JobsService } from '../jobs/jobs.service';
import { JobDispatchService } from '../jobs/job-dispatch.service';
import { JobRole, PermissionMode } from '../jobs/job-state';
import { JobDocument } from '../jobs/schemas/job.schema';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Draft, DraftDocument } from '../planning/schemas/draft.schema';
import { blockingWorkItemIds } from '../planning/dependency-refs';
import { blockedReason, DependencyState } from './blocking-dependencies';

/** Parent Story states that mean "approved for development" (Scrum: New→Approved→Committed→Done). */
const APPROVED_PARENT_STATES = ['Approved', 'Committed'];

/** A request to start development on a single approved ADO Task. */
export interface StartDevelopmentInput {
  workItemId: string;
  repo: string;
}

/** Verdict of an eligibility check against Azure DevOps (non-throwing; used by batch enumeration). */
export interface EligibilityVerdict {
  eligible: boolean;
  reason?: string;
  /** Repo from the Task's `repo:<name>` tag, if any (used to resolve the batch target repo). */
  /** Every `repo:` tag on the work item; the resolver picks whichever names a real target. */
  repoTag?: string[] | null;
}

/** Options for a batch dispatch wave. */
export interface StartDevelopmentBatchOptions {
  /** Max pods to dispatch this wave (concurrency budget). Remaining eligible Tasks are deferred. */
  maxDispatch?: number;
}

/** Outcome of a batch dispatch wave — the observable/auditable summary. */
export interface BatchDispatchResult {
  dispatched: JobDocument[];
  /** Tasks skipped because a run is already active (idempotent re-trigger). */
  skippedActive: string[];
  /** Tasks not dispatched because they failed eligibility, with the reason. */
  ineligible: { workItemId: string; reason: string }[];
  /** Eligible Tasks left for a later wave because the concurrency budget was exhausted. */
  deferred: string[];
  /** Total To Do Task candidates enumerated in the project area path. */
  candidates: number;
}

/**
 * Dispatches a **Developer** run per approved ADO Task (ARCHITECTURE.md §4A). Reuses the existing
 * execution seam — one AKS pod per Task (`role=developer`, bypass permissions) via the shared
 * {@link JobDispatchService}, the {@link JobsService} state machine (which enforces
 * one-active-run-per-work-item), and the per-run token. Human-triggered, one Task at a time: the
 * pod clones the repo, implements the Task, builds + tests, updates Azure DevOps, and commits.
 * Creation of work items stays with the backend/approval flow — this only starts the run.
 */
@Injectable()
export class DevelopmentService {
  private readonly logger = new Logger(DevelopmentService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
    private readonly dispatcher: JobDispatchService,
    private readonly ado: AdoClientService,
    private readonly config: AppConfigService,
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
  ) {}

  /**
   * The work a Task must wait for, read from the plan it came from.
   *
   * Dependencies live in the backlog, not on the Azure DevOps work item, so they are looked up by
   * the id the item was pushed under. Every draft of the project is searched, because the whole
   * point is a dependency that crosses plans: an enhancement Task waiting on a Task from the
   * original plan.
   *
   * Best-effort by design. A Bug filed by QA belongs to no draft and has no dependencies; a draft
   * that cannot be read must not stop development. In both cases the answer is "nothing is waiting",
   * which is what the system did before this existed.
   */
  private async blockingDependenciesOf(
    workItemId: number,
    owner: string,
  ): Promise<DependencyState[]> {
    try {
      const drafts = await this.draftModel.find({ projectId: new Types.ObjectId(owner) }).exec();
      for (const draft of drafts) {
        const byId = new Map(draft.backlog.map((i) => [i.id, i]));
        const item = draft.backlog.find((i) => i.adoId === workItemId);
        if (!item) continue;
        const ids = blockingWorkItemIds(item, byId);
        if (ids.length === 0) return [];
        const items = await this.ado
          .for(owner)
          .getWorkItemsBatch(ids, ['System.State', 'System.Title']);
        return items.map((wi) => ({
          id: wi.id,
          title: String(wi.fields['System.Title'] ?? `Work item ${wi.id}`),
          state: String(wi.fields['System.State'] ?? ''),
        }));
      }
      return [];
    } catch (err) {
      this.logger.warn(
        `Could not read dependencies for work item ${workItemId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Verifies the Task is eligible for a Developer run against Azure DevOps (PBI 18222 AC): it must
   * exist as a **Task**, be in **To Do**, and have a parent Story that is **approved** for
   * development (Approved/Committed). Fails fast with a clear error before any pod is dispatched, so
   * an ineligible or non-existent work item never spins up a run. Reads via the REST client (PAT),
   * independent of the in-pod ADO MCP.
   */
  private async assertTaskEligible(workItemId: string, owner: string): Promise<void> {
    const verdict = await this.checkTaskEligible(workItemId, owner);
    if (!verdict.eligible) {
      throw new BadRequestException(verdict.reason);
    }
  }

  /**
   * Non-throwing eligibility check against Azure DevOps (PBI 18222 AC), shared by the single-Task
   * path ({@link assertTaskEligible}) and batch enumeration. A Task is eligible when it exists as a
   * **Task**, is **To Do**, and its parent Story is **approved** (Approved/Committed). Also surfaces
   * the Task's `repo:<name>` tag so a batch can resolve the target repo per Task.
   */
  private async checkTaskEligible(workItemId: string, owner: string): Promise<EligibilityVerdict> {
    const id = Number(workItemId);
    if (!Number.isInteger(id) || id <= 0) {
      return {
        eligible: false,
        reason: `'${workItemId}' is not a valid Azure DevOps work item id.`,
      };
    }
    const [task] = await this.ado
      .for(owner)
      .getWorkItemsBatch(
        [id],
        ['System.WorkItemType', 'System.State', 'System.Parent', 'System.Tags'],
      );
    if (!task) {
      return { eligible: false, reason: `Task ${id} does not exist in Azure DevOps.` };
    }
    const type = String(task.fields['System.WorkItemType'] ?? '');
    const kind = workItemKindOf(type);
    // A Developer agent implements new work (**Task**) and fixes QA-found defects (**Bug**, D-019).
    if (kind === 'other') {
      return {
        eligible: false,
        reason: `Work item ${id} is a '${type}'; a Developer Agent runs on Tasks and Bugs only.`,
      };
    }
    const state = String(task.fields['System.State'] ?? '');
    /*
     * The starting state differs by type. A Task waits in `To Do`. A Bug waits in `New` — or in
     * `Committed`, because a QA agent that rejects a fix reopens the Bug to `Committed` rather than
     * to `New`. Refusing that left a genuinely unfixed Bug permanently unactionable: the board
     * showed it as "being worked on" ten hours after the last run had finished. A run already in
     * flight is still refused, by the enqueue guard that owns that question.
     */
    if (kind === 'bug') {
      if (state !== 'New' && state !== 'Committed') {
        return {
          eligible: false,
          reason: `Bug ${id} is '${state}', not 'New' or 'Committed'; only those can start a fix.`,
        };
      }
    } else if (state !== 'To Do') {
      return {
        eligible: false,
        reason: `${type} ${id} is '${state}', not 'To Do'; only a To Do ${type} can start development.`,
      };
    }
    const ownTags = String(task.fields['System.Tags'] ?? '');
    const parentId =
      typeof task.fields['System.Parent'] === 'number'
        ? (task.fields['System.Parent'] as number)
        : null;

    /*
     * A Bug needs no parent approval — but it does need a repository, and QA does not always tag
     * the Bugs it files. The Story it was found in always carries the tag, so the parent is read
     * for that alone. A Bug with no parent at all keeps whatever it has, which may be nothing.
     */
    if (kind === 'bug') {
      if (!parentId) {
        return { eligible: true, repoTag: effectiveRepoTags(ownTags) };
      }
      const [bugParent] = await this.ado.for(owner).getWorkItemsBatch([parentId], ['System.Tags']);
      return {
        eligible: true,
        repoTag: effectiveRepoTags(ownTags, String(bugParent?.fields['System.Tags'] ?? '')),
      };
    }

    if (!parentId) {
      return {
        eligible: false,
        reason: `Task ${id} has no parent Story to verify approval against.`,
      };
    }
    const [parent] = await this.ado
      .for(owner)
      .getWorkItemsBatch([parentId], ['System.State', 'System.Tags']);
    const parentState = String(parent?.fields['System.State'] ?? '');
    if (!APPROVED_PARENT_STATES.includes(parentState)) {
      return {
        eligible: false,
        reason: `Parent Story ${parentId} is '${parentState}', not approved (Approved/Committed); approve it before starting development.`,
      };
    }
    /*
     * The last gate: a Task waits for the work it depends on.
     *
     * Everything above asks whether *this* item is ready. This asks whether what it needs is. An
     * enhancement Task — "add a dark mode toggle to the Settings page" — is well-formed, approved
     * and correctly tagged while the Settings page itself is still in To Do; without this it would
     * be dispatched, and the agent would find nothing to change.
     *
     * The verdict is deliberately "not eligible" rather than an error: the queue steps over it and
     * runs something else, and it becomes eligible on its own once the blocker reaches Done.
     */
    const blockers = await this.blockingDependenciesOf(id, owner);
    const waiting = blockedReason(id, blockers);
    if (waiting) {
      return { eligible: false, reason: waiting };
    }

    return {
      eligible: true,
      repoTag: effectiveRepoTags(ownTags, String(parent?.fields['System.Tags'] ?? '')),
    };
  }

  /** Extracts the `repo:<name>` tag value from a semicolon-delimited ADO tag string, if present. */
  static parseRepoTag(tags: string): string | null {
    return parseRepoTag(tags);
  }

  /** Resolves the target repo for a batch Task: its `repo:` tag if allowed, else the sole target repo. */
  static resolveRepo(
    project: ProjectDocument,
    repoTag: string | string[] | null | undefined,
  ): string | undefined {
    return resolveRepo(project.targetRepos, repoTag);
  }

  /**
   * Builds the Developer job spec from a request, enforcing eligibility. A Developer run always
   * targets a concrete work item and repo and always runs in bypass mode (the pod is isolated and
   * autonomous). If the project declares an allow-list of repos, the requested repo must be on it.
   * Pure and testable — the dispatch side effects live in {@link startDevelopment}.
   */
  composeJobSpec(
    project: ProjectDocument,
    input: StartDevelopmentInput,
    runId: string,
  ): EnqueueJobSpec {
    const workItemId = input.workItemId?.trim();
    const repo = input.repo?.trim();
    if (!workItemId) {
      throw new BadRequestException('A work item id is required to start development.');
    }
    if (!repo) {
      throw new BadRequestException('A target repository is required to start development.');
    }
    if (project.targetRepos.length > 0 && !project.targetRepos.includes(repo)) {
      throw new BadRequestException(
        `Repo '${repo}' is not one of the project's target repositories.`,
      );
    }
    return {
      runId,
      role: JobRole.Developer,
      projectId: project.id as string,
      workItemId,
      repo,
      permissionMode: PermissionMode.BypassPermissions,
    };
  }

  /**
   * Starts a Developer run for one Task: enqueue the job (one active run per work item, else 409),
   * then dispatch the pod through the shared dispatcher. If the backend is unreachable (e.g. local
   * dev without a cluster) the job stays Queued for the reclaim scheduler / a runner to pick up —
   * dispatch never hard-fails.
   */
  async startDevelopment(projectId: string, input: StartDevelopmentInput): Promise<JobDocument> {
    const project = await this.projects.findById(projectId); // 404 if unknown
    const runId = randomUUID();
    const spec = this.composeJobSpec(project, input, runId);
    await this.assertTaskEligible(spec.workItemId!, projectId); // 400 if the Task is missing / not To Do / parent not approved
    const job = await this.jobs.enqueue(spec); // 409 if an active run already exists for the Task
    await this.dispatchJob(job);
    return job;
  }

  /**
   * Dispatches an enqueued job's pod, never hard-failing: if the execution backend is unreachable
   * (e.g. local dev without a cluster) the job stays Queued for the reclaim scheduler / a runner.
   */
  private async dispatchJob(job: JobDocument): Promise<void> {
    try {
      await this.dispatcher.dispatch(job);
    } catch (err) {
      this.logger.warn(
        `Execution backend unavailable for developer run ${job.runId}; job left Queued: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Batch trigger (Phase 2.1, ARCHITECTURE.md §4C): enumerate every eligible `To Do` Task in the
   * project's ADO area path and fan out **one Developer pod per Task**, mirroring `startQaBatch`.
   * Idempotent — a Task with an active run is skipped, so re-triggering (or a scheduler re-tick)
   * only picks up new work. Respects the concurrency budget (`maxDispatch`): eligible Tasks beyond
   * the budget are deferred to a later wave. The single-Task {@link startDevelopment} path is
   * unchanged. "Active sprint" here is the project's actionable To Do backlog under its one area
   * path (ARCHITECTURE.md §8 — one area path per project).
   */
  async startDevelopmentBatch(
    projectId: string,
    opts: StartDevelopmentBatchOptions = {},
  ): Promise<BatchDispatchResult> {
    const project = await this.projects.findById(projectId); // 404 if unknown
    const ids = await this.enumerateCandidateTasks(project);
    return this.dispatchTasks(project, ids.map(String), await this.resolveBudget(opts.maxDispatch));
  }

  /**
   * Dispatches a Developer run for an **explicit set of Tasks** — the Development board's
   * "Start Development" action on the selected cards (To Do → In Progress). Applies exactly the
   * same guards as the batch: ADO eligibility, one active run per Task, repo resolution, and the
   * global concurrency cap (selections beyond the cap are reported as deferred, never dropped).
   */
  async startDevelopmentForTasks(
    projectId: string,
    workItemIds: string[],
    maxDispatch?: number,
  ): Promise<BatchDispatchResult> {
    const project = await this.projects.findById(projectId); // 404 if unknown
    return this.dispatchTasks(project, workItemIds, await this.resolveBudget(maxDispatch));
  }

  /**
   * The concurrency cap applies to BOTH the manual trigger and the scheduler (D-023): when the
   * caller gives no explicit budget, bound it to the remaining global capacity so a single click can
   * never exceed MAX_CONCURRENT_RUNS; the scheduler passes its own already-capped budget.
   */
  private async resolveBudget(maxDispatch?: number): Promise<number> {
    return (
      maxDispatch ?? Math.max(0, this.config.maxConcurrentRuns - (await this.jobs.countActive()))
    );
  }

  /** Shared dispatch wave over a concrete list of Task ids (batch enumeration or a board selection). */
  private async dispatchTasks(
    project: ProjectDocument,
    ids: string[],
    startingBudget: number,
  ): Promise<BatchDispatchResult> {
    const result: BatchDispatchResult = {
      dispatched: [],
      skippedActive: [],
      ineligible: [],
      deferred: [],
      candidates: ids.length,
    };
    let budget = startingBudget;

    for (const id of ids) {
      const workItemId = String(id);
      // Idempotency: skip Tasks that already have an active run (re-trigger / re-tick is a no-op).
      if (await this.jobs.findActiveForWorkItem(workItemId)) {
        result.skippedActive.push(workItemId);
        continue;
      }
      const verdict = await this.checkTaskEligible(workItemId, project.id as string);
      if (!verdict.eligible) {
        result.ineligible.push({ workItemId, reason: verdict.reason ?? 'ineligible' });
        continue;
      }
      if (budget <= 0) {
        result.deferred.push(workItemId);
        continue;
      }
      const repo = DevelopmentService.resolveRepo(project, verdict.repoTag);
      if (!repo) {
        result.ineligible.push({
          workItemId,
          reason: 'no target repository resolvable for the Task',
        });
        continue;
      }
      const spec = this.composeJobSpec(project, { workItemId, repo }, randomUUID());
      try {
        const job = await this.jobs.enqueue(spec); // 409 if it raced into an active run
        await this.dispatchJob(job);
        result.dispatched.push(job);
        budget -= 1;
      } catch (err) {
        if (err instanceof ConflictException) {
          result.skippedActive.push(workItemId);
        } else {
          throw err;
        }
      }
    }
    return result;
  }

  /** Enumerates `To Do` Task ids under the project's ADO area path (batch candidate set). */
  private async enumerateCandidateTasks(project: ProjectDocument): Promise<number[]> {
    const adoProject = project.adoTarget.project;
    const areaPath = project.adoTarget.areaPath.replace(/'/g, "''");
    const wiql =
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.TeamProject] = '${adoProject.replace(/'/g, "''")}' ` +
      `AND [System.AreaPath] UNDER '${areaPath}' ` +
      `AND [System.WorkItemType] = 'Task' ` +
      `AND [System.State] = 'To Do' ` +
      `ORDER BY [System.Id] ASC`;
    return this.ado.for(project.id as string).queryWorkItemIds(adoProject, wiql);
  }
}

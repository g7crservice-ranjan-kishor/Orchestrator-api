import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../common/config/app-config.service';
import { AdoClientService } from '../ado/ado-client.service';
import { DevelopmentService } from '../development/development.service';
import { resolveQaRepo } from '../development/repo-resolution';
import { JobsService } from '../jobs/jobs.service';
import { JobDispatchService } from '../jobs/job-dispatch.service';
import { JobRole, PermissionMode } from '../jobs/job-state';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { ProjectsService } from '../projects/projects.service';
import { QaBatchDispatcher, QaDispatch } from '../orchestration/qa-batch.seam';
import {
  BUG_TYPE,
  QA_VERIFIED_TAG,
  QaItemKind,
  STORY_TYPE,
  hasQaVerifiedTag,
  isQaReady,
  qaItemKind,
} from './qa-workflow';

/** Verdict of a QA eligibility check against Azure DevOps (non-throwing; used by batch enumeration). */
export interface QaEligibilityVerdict {
  eligible: boolean;
  reason?: string;
  /** Story (Done) vs Bug (awaiting retest) — lets the pod pick the right test-vs-retest flow. */
  kind?: QaItemKind;
  /** Repo from the work item's `repo:<name>` tag, if any (used to resolve the batch target repo). */
  repoTag?: string | null;
  /** Work-item title, surfaced so the UI can name what it is about to test. */
  title?: string;
}

/** Options for a QA batch dispatch wave. */
export interface StartQaBatchOptions {
  /** Max pods to dispatch this wave (concurrency budget). Remaining eligible items are deferred. */
  maxDispatch?: number;
  /**
   * Validate only: enumerate and check eligibility, but **dispatch nothing**. Backs the "Start QA"
   * confirmation dialog — a QA wave costs one pod (and one Claude session) per item, so the user
   * sees exactly what would run first.
   */
  dryRun?: boolean;
  /**
   * Restrict the wave to these work items — the per-Story **Start Testing** button. Eligibility,
   * idempotency and the concurrency budget are unchanged, so one Story and the whole project take
   * exactly the same path (D-028 §6).
   */
  workItemIds?: string[];
}

/** Outcome of a QA batch dispatch wave — the observable/auditable summary. */
export interface QaBatchResult {
  /** One entry per dispatched pod. Shaped as {@link QaDispatch} so this satisfies {@link QaBatchDispatcher}. */
  dispatched: QaDispatch[];
  /** Items skipped because a run is already active (idempotent re-trigger / re-tick). */
  skippedActive: string[];
  /** Items not dispatched because they failed eligibility, with the reason. */
  ineligible: { workItemId: string; reason: string }[];
  /** Eligible items left for a later wave because the concurrency budget was exhausted. */
  deferred: string[];
  /** Total Ready-for-QA candidates enumerated in the project area path. */
  candidates: number;
  /** True when this was a preview — `dispatched` lists what *would* run and nothing was started. */
  dryRun: boolean;
}

/**
 * Dispatches a **QA** run per Ready-for-QA work item (ARCHITECTURE.md §4B, D-018), mirroring the
 * Phase-2 {@link DevelopmentService}. A single manual "Start QA" (or a scheduler QA-leg tick)
 * enumerates every Story in **Done** and every Bug **awaiting retest** under the project's ADO area
 * path and fans out **one isolated QA K8s Job per item** (`role=qa`, `workItemId`, `repo`, bypass)
 * via the shared {@link JobDispatchService}. Reuses the {@link JobsService} state machine (which
 * enforces one-active-run-per-work-item, making re-clicking idempotent), the lease/heartbeat, and
 * the reclaim scheduler. QA is **human-triggered** — there is deliberately no auto-dispatch on Story
 * Done. Implements {@link QaBatchDispatcher} and is bound to `QA_BATCH_DISPATCHER` so the
 * orchestration scheduler's QA leg activates (ARCHITECTURE.md §4C).
 */
@Injectable()
export class QaService implements QaBatchDispatcher {
  private readonly logger = new Logger(QaService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
    private readonly dispatcher: JobDispatchService,
    private readonly ado: AdoClientService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Non-throwing QA eligibility check against Azure DevOps, shared by batch enumeration. An item is
   * eligible when it exists as a **Story (Done)** or a **Bug (awaiting retest = Done)** — the
   * verified project state model (qa-workflow.ts). Also surfaces the `repo:<name>` tag so a batch
   * can resolve the target repo per item, and the QA item kind (story vs bug).
   */
  private async checkQaEligible(workItemId: string, owner: string): Promise<QaEligibilityVerdict> {
    const id = Number(workItemId);
    if (!Number.isInteger(id) || id <= 0) {
      return {
        eligible: false,
        reason: `'${workItemId}' is not a valid Azure DevOps work item id.`,
      };
    }
    const [item] = await this.ado
      .for(owner)
      .getWorkItemsBatch(
        [id],
        ['System.WorkItemType', 'System.State', 'System.Tags', 'System.Title'],
      );
    if (!item) {
      return { eligible: false, reason: `Work item ${id} does not exist in Azure DevOps.` };
    }
    const type = String(item.fields['System.WorkItemType'] ?? '');
    const kind = qaItemKind(type);
    if (!kind) {
      return {
        eligible: false,
        reason: `Work item ${id} is a '${type}', not a Story or Bug; QA tests Stories and Bugs only.`,
      };
    }
    const state = String(item.fields['System.State'] ?? '');
    if (!isQaReady(type, state)) {
      const expected = kind === 'story' ? "'Done' (Ready for QA)" : "'Done' (awaiting retest)";
      return {
        eligible: false,
        reason: `${type} ${id} is '${state}', not ${expected}; not ready for QA.`,
      };
    }
    const tags = String(item.fields['System.Tags'] ?? '');
    // D-025, extended to Stories: a passing QA leaves the work item in `Done` — exactly the state
    // enumeration selects — so without the tag every wave re-tests (and re-pays for) everything that
    // already passed. The tag is the only thing that makes the QA leg converge.
    if (hasQaVerifiedTag(tags)) {
      return {
        eligible: false,
        reason: `${type} ${id} is already tagged '${QA_VERIFIED_TAG}'; QA passed on it. It will be retested once development reopens it.`,
      };
    }
    const repoTag = DevelopmentService.parseRepoTag(tags);
    return { eligible: true, kind, repoTag, title: String(item.fields['System.Title'] ?? '') };
  }

  /**
   * Builds the QA job spec. A QA run always targets a concrete work item + repo and always runs in
   * bypass mode (the pod is isolated and autonomous). If the project declares an allow-list of
   * repos, the resolved repo must be on it. Pure and testable — dispatch side effects live in
   * {@link startQaBatch}.
   */
  composeJobSpec(project: ProjectDocument, workItemId: string, repo: string, runId: string) {
    return {
      runId,
      role: JobRole.QA,
      projectId: project.id as string,
      workItemId,
      repo,
      permissionMode: PermissionMode.BypassPermissions,
    };
  }

  /**
   * Manual/auto batch trigger (ARCHITECTURE.md §4B/§4C, D-018): enumerate every Ready-for-QA item in
   * the project's ADO area path (Stories in Done + Bugs awaiting retest) and fan out **one QA pod
   * per item**. Idempotent — an item with an active run is skipped, so re-clicking (or a scheduler
   * re-tick) never double-dispatches an item already under test and only picks up new work. Respects
   * the concurrency budget (`maxDispatch`): eligible items beyond the budget are deferred to a later
   * wave. Human-triggered; there is no auto-dispatch on Story→Done.
   */
  async startQaBatch(projectId: string, opts: StartQaBatchOptions = {}): Promise<QaBatchResult> {
    const project = await this.projects.findById(projectId); // 404 if unknown
    const requested = opts.workItemIds?.map((id) => Number(id)).filter(Number.isInteger);
    const enumerated = await this.enumerateReadyForQa(project);
    // A narrowed wave still runs the same eligibility checks — the caller cannot force a Story that
    // is not actually ready, it just chooses which of the ready ones to start.
    const ids = requested?.length ? enumerated.filter((id) => requested.includes(id)) : enumerated;
    const dryRun = Boolean(opts.dryRun);
    const result: QaBatchResult = {
      dispatched: [],
      skippedActive: [],
      ineligible: [],
      deferred: [],
      candidates: ids.length,
      dryRun,
    };
    // Cap applies to BOTH the manual trigger and the scheduler (D-023): with no explicit budget
    // (manual "Start QA"), bound to the remaining global capacity so one click can never exceed
    // MAX_CONCURRENT_RUNS; the scheduler passes its own already-capped budget.
    let budget =
      opts.maxDispatch ??
      Math.max(0, this.config.maxConcurrentRuns - (await this.jobs.countActive()));

    for (const id of ids) {
      const workItemId = String(id);
      // Idempotency: skip items that already have an active run (re-trigger / re-tick is a no-op).
      if (await this.jobs.findActiveForWorkItem(workItemId)) {
        result.skippedActive.push(workItemId);
        continue;
      }
      const verdict = await this.checkQaEligible(workItemId, project.id as string);
      if (!verdict.eligible) {
        result.ineligible.push({ workItemId, reason: verdict.reason ?? 'ineligible' });
        continue;
      }
      if (budget <= 0) {
        result.deferred.push(workItemId);
        continue;
      }
      // `resolveQaRepo`, not `resolveRepo`: a Story whose Tasks span both repositories carries no
      // repository of its own, and QA clones the others as companions anyway, so where it starts is
      // a working directory rather than a claim. See repo-resolution.ts.
      const repo = resolveQaRepo(project.targetRepos, verdict.repoTag);
      if (!repo) {
        result.ineligible.push({
          workItemId,
          reason:
            'this project has no target repository configured, so there is nothing for QA to ' +
            'check out. Add one on the project before starting a QA wave.',
        });
        continue;
      }
      if (dryRun) {
        // Nothing is enqueued or dispatched; the empty runId marks a previewed item.
        result.dispatched.push({ runId: '', workItemId, title: verdict.title, kind: verdict.kind });
        budget -= 1;
        continue;
      }
      const spec = this.composeJobSpec(project, workItemId, repo, randomUUID());
      try {
        const job = await this.jobs.enqueue(spec); // 409 if it raced into an active run
        await this.dispatchJob(job.runId, job);
        result.dispatched.push({
          runId: job.runId,
          workItemId,
          title: verdict.title,
          kind: verdict.kind,
        });
        // Per-dispatch structured log (no secrets) — mirrors the orchestration audit trail.
        this.logger.log(
          JSON.stringify({
            event: 'qa.dispatch',
            runId: job.runId,
            workItemId,
            kind: verdict.kind,
          }),
        );
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

  /**
   * Dispatches an enqueued job's pod, never hard-failing: if the execution backend is unreachable
   * (e.g. local dev without a cluster) the job stays Queued for the reclaim scheduler / a runner.
   */
  private async dispatchJob(runId: string, job: Parameters<JobDispatchService['dispatch']>[0]) {
    try {
      await this.dispatcher.dispatch(job);
    } catch (err) {
      this.logger.warn(
        `Execution backend unavailable for QA run ${runId}; job left Queued: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Enumerates Ready-for-QA work-item ids under the project's ADO area path: Stories in `Done` and
   * Bugs awaiting retest (`Done`). Derived from the verified QA-ready signal set (qa-workflow.ts).
   */
  private async enumerateReadyForQa(project: ProjectDocument): Promise<number[]> {
    const adoProject = project.adoTarget.project;
    const areaPath = project.adoTarget.areaPath.replace(/'/g, "''");
    const wiql =
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.TeamProject] = '${adoProject.replace(/'/g, "''")}' ` +
      `AND [System.AreaPath] UNDER '${areaPath}' ` +
      `AND [System.WorkItemType] IN ('${STORY_TYPE}', '${BUG_TYPE}') ` +
      `AND [System.State] = 'Done' ` +
      `ORDER BY [System.Id] ASC`;
    return this.ado.for(project.id as string).queryWorkItemIds(adoProject, wiql);
  }
}

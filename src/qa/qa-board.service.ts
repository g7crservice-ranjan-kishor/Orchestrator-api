import { Injectable } from '@nestjs/common';
import {
  AdoBoardService,
  TaskExecution,
  WorkItemRef,
  toTaskExecution,
} from '../ado/ado-board.service';
import { AdoClientService } from '../ado/ado-client.service';
import { JobRole, JobState } from '../jobs/job-state';
import { JobDocument } from '../jobs/schemas/job.schema';
import { JobsService } from '../jobs/jobs.service';
import { ProjectsService } from '../projects/projects.service';
import { hasQaVerifiedTag } from './qa-workflow';

/** Where a Story sits in the QA pipeline — the four buckets the QA view groups by. */
export type QaStoryStatus = 'Ready for QA' | 'Testing' | 'Failed / Fix Required' | 'Completed';

export const QA_STORY_STATUSES: readonly QaStoryStatus[] = [
  'Ready for QA',
  'Testing',
  'Failed / Fix Required',
  'Completed',
];

/** A Bug QA filed against a Story, as the QA view shows it. */
export interface QaBug {
  adoId: number;
  title: string;
  /** Raw ADO state: `New` (filed) → `Committed` (being fixed) → `Done` (awaiting retest / verified). */
  state: string;
  severity: string | null;
  assignedTo: string | null;
  /** True once QA has retested the fix and passed it (D-025). */
  qaVerified: boolean;
  /** True while a Developer agent is fixing it. */
  fixRunning: boolean;
  /** Whether a Developer agent can be dispatched on it now, and why not when it cannot. */
  canFix: { allowed: boolean; reason?: string };
}

/** One Story card on the QA view. QA works Story-by-Story; the Task board stays Task-by-Task. */
export interface QaStory {
  adoId: number;
  title: string;
  /** Plain-text description (ADO stores HTML); the UI shows a short summary. */
  description: string;
  /** Raw ADO state, kept for traceability. */
  state: string;
  status: QaStoryStatus;
  feature: WorkItemRef | null;
  epic: WorkItemRef | null;
  sprint: string | null;
  /** Who developed it (the Story's ADO assignee) — shown so QA knows who to talk to. */
  developer: string | null;
  tasksTotal: number;
  tasksDone: number;
  /** Open (not Done) Bugs filed against this Story — what makes it "Fix Required". */
  openBugs: number;
  /** Every Bug filed against this Story, newest first, so the UI can act on them. */
  bugs: QaBug[];
  /** True once QA has passed it; such a Story is never re-tested until development reopens it. */
  qaVerified: boolean;
  /** ADO `System.ChangedDate`, for the "Updated 2 hours ago" line. */
  updatedAt: string | null;
  /** Latest QA run for this Story, if any. */
  execution: TaskExecution | null;
  /** True while a QA agent is working on it. */
  qaRunning: boolean;
  /** Whether "Start Testing" is available, and why not when it is not. */
  canStart: { allowed: boolean; reason?: string };
}

export interface QaBoard {
  stories: QaStory[];
}

const BUG_FIELDS = [
  'System.Title',
  'System.State',
  'System.Parent',
  'System.Tags',
  'System.AssignedTo',
  'Microsoft.VSTS.Common.Severity',
];

const STORY_FIELDS = [
  'System.Title',
  'System.Description',
  'System.State',
  'System.AssignedTo',
  'System.Tags',
  'System.ChangedDate',
  'System.IterationPath',
];

/** ADO stores rich text as HTML; the card shows a short plain-text summary. */
export function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which QA bucket a Story belongs in. Derived from Azure DevOps state + the `qa-verified` tag +
 * live run status — never from a flag of our own, so the view cannot disagree with ADO (D-020).
 *
 * `Failed / Fix Required` is a Story that QA reopened: it sits in `Committed` with an open Bug
 * against it. A `Committed` Story with no Bug is simply still being developed and is not shown.
 */
export function qaStatusOf(input: {
  state: string;
  qaVerified: boolean;
  qaRunning: boolean;
  openBugs: number;
}): QaStoryStatus | null {
  if (input.qaRunning) {
    return 'Testing';
  }
  if (input.openBugs > 0) {
    return 'Failed / Fix Required';
  }
  const state = input.state.trim().toLowerCase();
  if (state !== 'done') {
    return null; // still in development — not a QA concern yet
  }
  return input.qaVerified ? 'Completed' : 'Ready for QA';
}

/**
 * Story-level projection for the **QA view** (D-028). The Development board answers "what is the
 * Developer agent doing?" one Task at a time; this answers "what can QA test, what is under test,
 * and what came back broken?" one Story at a time. Both read Azure DevOps — neither keeps its own
 * copy of work-item state.
 */
@Injectable()
export class QaBoardService {
  constructor(
    private readonly board: AdoBoardService,
    private readonly client: AdoClientService,
    private readonly jobs: JobsService,
    private readonly projects: ProjectsService,
  ) {}

  async getQaBoard(projectId: string): Promise<QaBoard> {
    const [board, project, jobs] = await Promise.all([
      this.board.getBoard(projectId),
      this.projects.findById(projectId),
      this.jobs.listForProject(projectId),
    ]);

    // The Task board already carries each Task's Story/Feature/Epic, so the hierarchy and the
    // per-Story Task counts come for free — no extra Azure DevOps round trips.
    const tasks = board.columns.flatMap((c) => c.tasks);
    const storyIds = [
      ...new Set(
        tasks
          .map((t) => t.story?.adoId)
          .filter((id): id is number => typeof id === 'number' && id > 0),
      ),
    ];
    if (storyIds.length === 0) {
      return { stories: [] };
    }

    const [items, bugsByStory] = await Promise.all([
      this.client.for(projectId).getWorkItemsBatch(storyIds, STORY_FIELDS),
      this.bugsByStory(
        project.adoTarget.project,
        project.adoTarget.areaPath,
        jobs,
        project.id as string,
      ),
    ]);

    const latestQaRun = QaBoardService.latestQaRunByWorkItem(jobs);
    const stories: QaStory[] = [];

    for (const wi of items) {
      const own = tasks.filter((t) => t.story?.adoId === wi.id);
      const run = latestQaRun.get(String(wi.id)) ?? null;
      const qaRunning = Boolean(run && !QaBoardService.isTerminal(run.state as JobState));
      const bugs = bugsByStory.get(wi.id) ?? [];
      const openBugs = bugs.filter((b) => b.state.trim().toLowerCase() !== 'done').length;
      const qaVerified = hasQaVerifiedTag(String(wi.fields['System.Tags'] ?? ''));
      const state = String(wi.fields['System.State'] ?? '');

      const status = qaStatusOf({ state, qaVerified, qaRunning, openBugs });
      if (!status) {
        continue; // still in development
      }

      const tasksDone = own.filter((t) => t.status === 'Done').length;
      stories.push({
        adoId: wi.id,
        title: String(wi.fields['System.Title'] ?? ''),
        description: toPlainText(String(wi.fields['System.Description'] ?? '')),
        state,
        status,
        feature: own[0]?.feature ?? null,
        epic: own[0]?.epic ?? null,
        sprint: own[0]?.sprint ?? QaBoardService.leafOf(wi.fields['System.IterationPath']),
        developer: QaBoardService.identityName(wi.fields['System.AssignedTo']),
        tasksTotal: own.length,
        tasksDone,
        openBugs,
        bugs,
        qaVerified,
        updatedAt: wi.fields['System.ChangedDate'] ? String(wi.fields['System.ChangedDate']) : null,
        execution: run ? toTaskExecution(run) : null,
        qaRunning,
        canStart: QaBoardService.startability(status, qaRunning),
      });
    }

    stories.sort((a, b) => a.adoId - b.adoId);
    return { stories };
  }

  /** Why "Start Testing" is or is not offered — the same reasons the dispatch itself would give. */
  private static startability(
    status: QaStoryStatus,
    qaRunning: boolean,
  ): { allowed: boolean; reason?: string } {
    if (qaRunning) {
      return { allowed: false, reason: 'A QA agent is already testing this Story.' };
    }
    if (status === 'Completed') {
      return {
        allowed: false,
        reason:
          'QA already passed this Story. It is retested automatically once development reopens it.',
      };
    }
    if (status === 'Failed / Fix Required') {
      return {
        allowed: false,
        reason: 'Waiting on a developer to fix the open Bug, then the Story returns for retest.',
      };
    }
    return { allowed: true };
  }

  /**
   * Every Bug under the project's area path, grouped by the Story it was filed against — one query
   * rather than one per Story. Includes fixed Bugs so the UI can show the whole loop, not just what
   * is outstanding.
   */
  private async bugsByStory(
    adoProject: string,
    areaPath: string,
    jobs: JobDocument[],
    owner: string,
  ): Promise<Map<number, QaBug[]>> {
    const byStory = new Map<number, QaBug[]>();
    const escaped = areaPath.replace(/'/g, "''");
    const ids = await this.client
      .for(owner)
      .queryWorkItemIds(
        adoProject,
        `SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER '${escaped}' ` +
          `AND [System.WorkItemType] = 'Bug' ORDER BY [System.Id] DESC`,
      );
    if (ids.length === 0) {
      return byStory;
    }
    const active = QaBoardService.activeDeveloperWorkItemIds(jobs);
    for (const wi of await this.client.for(owner).getWorkItemsBatch(ids, BUG_FIELDS)) {
      const parent = wi.fields['System.Parent'];
      if (typeof parent !== 'number') {
        continue; // a Bug with no Story to hang off cannot be shown in context
      }
      const state = String(wi.fields['System.State'] ?? '');
      const fixRunning = active.has(String(wi.id));
      const qaVerified = hasQaVerifiedTag(String(wi.fields['System.Tags'] ?? ''));
      const bug: QaBug = {
        adoId: wi.id,
        title: String(wi.fields['System.Title'] ?? ''),
        state,
        severity: (wi.fields['Microsoft.VSTS.Common.Severity'] as string) ?? null,
        assignedTo: QaBoardService.identityName(wi.fields['System.AssignedTo']),
        qaVerified,
        fixRunning,
        canFix: QaBoardService.fixability(state, fixRunning, qaVerified),
      };
      byStory.set(parent, [...(byStory.get(parent) ?? []), bug]);
    }
    return byStory;
  }

  /**
   * Whether a Developer agent can be dispatched on this Bug. Mirrors the dispatch rules: a Bug is
   * fixable while it sits in `New`, and not once it is being fixed or already awaiting retest.
   *
   * A verified Bug carries **no** reason. It used to be judged on its ADO state alone, and a Bug
   * QA had retested and passed still sits in `Done` — so the card showed a green "Verified by QA"
   * badge with "Fixed — waiting for QA to retest it." underneath it. Both were drawn from the same
   * record and they contradicted each other, which is worse than either one alone. The badge says
   * everything there is to say, so the line beneath it says nothing.
   */
  private static fixability(
    state: string,
    fixRunning: boolean,
    qaVerified: boolean,
  ): { allowed: boolean; reason?: string } {
    if (fixRunning) {
      return { allowed: false, reason: 'A Developer agent is fixing this Bug now.' };
    }
    if (qaVerified) {
      return { allowed: false };
    }
    const raw = state.trim().toLowerCase();
    if (raw === 'done') {
      return { allowed: false, reason: 'Fixed — waiting for QA to retest it.' };
    }
    /*
     * `New` and `Committed` are both actionable once nothing is running.
     *
     * `Committed` used to mean "a Developer is on it", and the board refused a second dispatch on
     * that basis. But a QA agent rejecting a fix reopens the Bug to `Committed` too — so a Bug
     * nobody was working on sat in the In Progress column with no action available, for ever. The
     * `fixRunning` check above is what actually knows whether a Developer is on it; the state does
     * not, and should not be asked to.
     */
    if (raw === 'new' || raw === 'committed') {
      return { allowed: true };
    }
    return { allowed: false, reason: `A Bug in '${state}' cannot be dispatched to a Developer.` };
  }

  /** Work items with a Developer run in flight, so a Bug being fixed cannot be dispatched twice. */
  private static activeDeveloperWorkItemIds(jobs: JobDocument[]): Set<string> {
    const active = new Set<string>();
    for (const job of jobs) {
      if (job.role !== JobRole.Developer || !job.workItemId) continue;
      if (!QaBoardService.isTerminal(job.state as JobState)) active.add(job.workItemId);
    }
    return active;
  }

  /**
   * Newest QA job per work item (the Story's current/last test). `listForProject` returns runs
   * newest-first, so the first one seen for a work item is the latest — same convention the
   * Development board uses.
   */
  static latestQaRunByWorkItem(jobs: JobDocument[]): Map<string, JobDocument> {
    const latest = new Map<string, JobDocument>();
    for (const job of jobs) {
      if (job.role !== JobRole.QA || !job.workItemId) continue;
      if (!latest.has(job.workItemId)) latest.set(job.workItemId, job);
    }
    return latest;
  }

  private static isTerminal(state: JobState): boolean {
    return [JobState.Completed, JobState.Cancelled, JobState.Failed].includes(state);
  }

  private static leafOf(path: unknown): string | null {
    const value = typeof path === 'string' ? path : '';
    return value ? (value.split(/[\\/]/).filter(Boolean).pop() ?? null) : null;
  }

  /** `System.AssignedTo` is an identity object in REST 7.0 (a plain string on older payloads). */
  private static identityName(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    const id = value as { displayName?: string; uniqueName?: string };
    return id.displayName?.trim() || id.uniqueName?.trim() || null;
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { allDrafts } from '../planning/draft-repository';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  BacklogItem,
  BacklogItemType,
  Draft,
  DraftDocument,
} from '../planning/schemas/draft.schema';
import { JobsService } from '../jobs/jobs.service';
import { JobRole, JobState } from '../jobs/job-state';
import { JobDocument } from '../jobs/schemas/job.schema';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { parseRepoTags, resolveExecutionAgent, resolveRepo } from '../development/repo-resolution';
import {
  ALLOWED_TRANSITIONS,
  BoardStatus,
  validateTaskTransition,
  effectiveBoardStatus,
} from '../development/task-transition-rules';
import { AdoClientService } from './ado-client.service';
import { SprintContext, SprintService, SprintTimeFrame } from './sprint.service';
import { AdoWorkItem } from './ado.types';

/**
 * Normalized Development-board execution state. This is a **presentation-layer** mapping over the
 * raw Azure DevOps states — ADO stays the source of truth and its values are never rewritten from
 * here (ARCHITECTURE.md §8, one-directional).
 */
export type TaskStatus = BoardStatus;

/** The Development workflow, left → right. Always rendered (even empty) so the pipeline reads clearly. */
export const TASK_COLUMNS: readonly TaskStatus[] = ['Draft', 'To Do', 'In Progress', 'Done'];

/** A parent work item carried as *context* on a Task card — Epics/Features/Stories are never cards. */
export interface WorkItemRef {
  adoId: number | null;
  title: string;
  /** Raw ADO state — used to check the parent Story is approved before development starts. */
  state: string | null;
}

/** The latest Developer run for a Task, projected from the existing jobs/execution records. */
export interface TaskExecution {
  runId: string;
  /** Job state: Queued / Claimed / Running / Completed / Failed / Cancelled / Blocked. */
  state: string;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  /** Why a run is Blocked (e.g. the token budget stopped it). */
  blockedReason: string | null;
  durationMs: number;
  tokens: number;
  cost: number;
  filesChanged: number;
  commits: string[];
}

/** Whether the single valid forward transition is currently permitted, and why not when it isn't. */
export interface TransitionAvailability {
  /** The only status a user may move this Task to, or null when there is none. */
  to: TaskStatus | null;
  allowed: boolean;
  reason?: string;
  hint?: string;
}

/**
 * One Task card — the Developer Agent's unit of execution (one agent run = one Task). Epic/Feature/
 * Story travel with the card as context so the board can be filtered by hierarchy, and so a later
 * QA view can tell when all of a Story's Tasks are Done.
 */
export interface BoardTask {
  /**
   * What the card is. A Developer agent executes **Tasks** (new work) and **Bugs** (defects QA
   * found, D-019) — both belong on this board because both are work a developer picks up.
   */
  kind: 'task' | 'bug';
  /** ADO id, or null while the Task is still an unpushed draft backlog item. */
  adoId: number | null;
  /** Stable key for the UI (ADO id when pushed, else the draft backlog item id). */
  key: string;
  title: string;
  /** Full description (ADO `System.Description`, HTML) — shown in the Task detail view. */
  description: string;
  /** Acceptance criteria (ADO `Microsoft.VSTS.Common.AcceptanceCriteria`, HTML). */
  acceptanceCriteria: string;
  /** Raw ADO state, kept for traceability (null for unpushed drafts). */
  state: string | null;
  status: TaskStatus;
  /** Leaf sprint name for display/filtering. */
  sprint: string | null;
  /** Full ADO iteration path — what the sprint classification is keyed on. */
  sprintPath: string | null;
  /** ADO's own classification of that iteration (drives the future-sprint rule). */
  sprintTimeFrame: SprintTimeFrame;
  /** The person the work item is assigned to in ADO (may be empty during planning). */
  assignee: string | null;
  /** The agent that would execute this Task — distinct from `assignee`. */
  executionAgent: string | null;
  repo: string | null;
  /** ADO `System.ChangedDate` — drives the card's "Updated 2 hours ago" line. */
  updatedAt: string | null;
  /** True while a Developer agent run is active on this Task. */
  agentRunning: boolean;
  /** Latest Developer run for this Task, if any (reuses the existing job records). */
  execution: TaskExecution | null;
  /** Backend-computed eligibility for the one valid forward move — the UI never re-derives rules. */
  canTransition: TransitionAvailability;
  story: WorkItemRef | null;
  feature: WorkItemRef | null;
  epic: WorkItemRef | null;
}

export interface BoardColumn {
  status: TaskStatus;
  tasks: BoardTask[];
}

export interface Board {
  pushed: boolean;
  /** Active sprint name from ADO, or null when it cannot be determined. */
  currentSprint: string | null;
  columns: BoardColumn[];
}

/** Raw ADO states meaning work has started (Scrum `In Progress`; Agile/Basic aliases included). */
const IN_PROGRESS_STATES = new Set(['in progress', 'doing', 'active', 'committed']);
/** Raw ADO states meaning the Task is finished. */
const DONE_STATES = new Set(['done', 'closed', 'completed', 'resolved']);
/** Raw ADO states meaning the Task is queued and eligible for a Developer agent. */
const TODO_STATES = new Set(['to do', 'todo', 'new', 'proposed', 'open']);
/** Cancelled work — hidden from the Development board entirely. */
const REMOVED_STATES = new Set(['removed', 'cut']);
/** Parent Story states that mean "approved for development". */
const APPROVED_PARENT_STATES = new Set(['approved', 'committed', 'done']);
/** Job states that mean the run has finished (used for the execution `completedAt`). */
const TERMINAL_JOB_STATES = new Set<string>([
  JobState.Completed,
  JobState.Failed,
  JobState.Cancelled,
]);

/** ADO classification paths are `Project\Area\Leaf`; accept either separator when taking the leaf. */
const PATH_SEPARATOR = /[\\/]/;

const BOARD_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.Parent',
  'System.IterationPath',
  'System.AssignedTo',
  'System.Tags',
  'System.Description',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
];

/** Where an ancestor sits in the Epic → Feature → Story hierarchy (null = not a hierarchy level). */
type HierarchyKind = 'epic' | 'feature' | 'story' | 'task' | null;

/** A node in the parent chain, normalised so ADO items and draft backlog items resolve identically. */
interface HierarchyNode {
  parentId: string | null;
  kind: HierarchyKind;
  ref: WorkItemRef;
  /** This item's own `repo:` tags, so a child with none can inherit them. */
  repoTags: string[];
}

/** Maps an ADO work-item type name onto a hierarchy level (Scrum + Agile/CMMI names). */
function kindOfAdoType(type: string): HierarchyKind {
  switch (type.trim().toLowerCase()) {
    case 'epic':
      return 'epic';
    case 'feature':
      return 'feature';
    case 'product backlog item':
    case 'user story':
    case 'requirement':
      return 'story';
    case 'task':
      return 'task';
    default:
      return null;
  }
}

/** Work-item types that get their own card: the things a Developer agent can be dispatched on. */
function cardKindOfAdoType(type: string): 'task' | 'bug' | null {
  const raw = type.trim().toLowerCase();
  if (raw === 'task') return 'task';
  if (raw === 'bug') return 'bug';
  return null;
}

/** Maps a draft backlog item type onto the same hierarchy levels. */
function kindOfBacklogType(type: BacklogItemType): HierarchyKind {
  switch (type) {
    case BacklogItemType.Epic:
      return 'epic';
    case BacklogItemType.Feature:
      return 'feature';
    case BacklogItemType.Story:
      return 'story';
    case BacklogItemType.Task:
      return 'task';
    default:
      return null;
  }
}

/**
 * Normalizes a raw ADO state onto the board's execution states. Unrecognised states fall back to
 * `Draft` so the Task stays **visible** at the start of the pipeline rather than being silently
 * claimed as started or done. Returns `null` for cancelled work, which the board drops.
 */
export function normalizeTaskState(state: string | null): TaskStatus | null {
  const raw = (state ?? '').trim().toLowerCase();
  if (!raw) return 'Draft'; // not in ADO yet
  if (REMOVED_STATES.has(raw)) return null;
  if (DONE_STATES.has(raw)) return 'Done';
  if (IN_PROGRESS_STATES.has(raw)) return 'In Progress';
  if (TODO_STATES.has(raw)) return 'To Do';
  return 'Draft';
}

/** Takes the leaf of an ADO iteration path; the bare project root means "no sprint assigned". */
function sprintLeaf(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const parts = raw.split(PATH_SEPARATOR).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

/** `System.AssignedTo` is an identity object in REST 7.0 (a plain string on older payloads). */
function assigneeName(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  const identity = value as { displayName?: string; uniqueName?: string };
  return identity.displayName?.trim() || identity.uniqueName?.trim() || null;
}

/**
 * Walks the parent chain and picks out the Story / Feature / Epic ancestors **by type**, not by
 * depth — so a Task linked straight to a Feature (or a hierarchy missing a level) still resolves the
 * levels that do exist. Cycle-safe.
 */
/**
 * The nearest ancestor's repo tags, for an item that carries none of its own.
 *
 * A Bug filed by a QA agent is a child of the Story it was found in, and the Story knows which
 * repository it belongs to. The agent tags the Bug most of the time — but only most of the time,
 * and an untagged Bug on a two-repository project resolves to no execution agent, so the board
 * refuses to start a fix for it with "No execution agent is assigned to this Task". Inheriting
 * removes the dependency on the agent remembering: the answer was always one link away.
 *
 * Returns an empty list when nothing up the chain has a tag, which is still the honest answer.
 */
export function inheritedRepoTags(
  startParentId: string | null,
  byId: ReadonlyMap<string, HierarchyNode>,
): string[] {
  const seen = new Set<string>();
  let cursor = startParentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    if (node.repoTags.length > 0) return node.repoTags;
    cursor = node.parentId;
  }
  return [];
}

export function resolveAncestors(
  startParentId: string | null,
  byId: ReadonlyMap<string, HierarchyNode>,
): Pick<BoardTask, 'story' | 'feature' | 'epic'> {
  let story: WorkItemRef | null = null;
  let feature: WorkItemRef | null = null;
  let epic: WorkItemRef | null = null;
  const seen = new Set<string>();
  let cursor = startParentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    if (node.kind === 'story' && !story) story = node.ref;
    else if (node.kind === 'feature' && !feature) feature = node.ref;
    else if (node.kind === 'epic' && !epic) epic = node.ref;
    cursor = node.parentId;
  }
  return { story, feature, epic };
}

/** Projects a job record onto the card's execution summary (no second tracking system). */
export function toTaskExecution(job: JobDocument): TaskExecution {
  const stamps = job as unknown as { createdAt?: Date; updatedAt?: Date };
  const terminal = TERMINAL_JOB_STATES.has(job.state);
  return {
    runId: job.runId,
    state: job.state,
    attempts: job.attempts ?? 0,
    startedAt: (job.lease?.acquiredAt ?? stamps.createdAt)?.toISOString() ?? null,
    completedAt: terminal ? (stamps.updatedAt?.toISOString() ?? null) : null,
    blockedReason: job.blockedReason ?? null,
    durationMs: job.result?.durationMs ?? 0,
    tokens: job.result?.tokens ?? 0,
    cost: job.result?.cost ?? 0,
    filesChanged: job.result?.filesChanged ?? 0,
    commits: job.result?.commits ?? [],
  };
}

/** The single forward move offered from a column (Draft → To Do, To Do → In Progress, else none). */
export function nextStatus(status: TaskStatus): TaskStatus | null {
  return ALLOWED_TRANSITIONS[status]?.[0] ?? null;
}

/**
 * **Task-centric** read-only projection of the Development board. Every card is a single ADO
 * **Task** — the Developer Agent's unit of execution (one run = one Task) — grouped into the
 * normalized `Draft → To Do → In Progress → Done` columns. Epics, Features and Stories are *never*
 * cards: they travel with each Task as hierarchy context (for display and filtering).
 *
 * Each card also carries the **backend-computed** transition eligibility (`canTransition`), derived
 * from the same {@link validateTaskTransition} rules the transition API enforces — so drag-and-drop
 * and the action buttons show exactly what the server will allow, with no duplicated logic.
 * One-directional: it reflects ADO plus live run status and never writes back (ARCHITECTURE.md §8).
 */
@Injectable()
export class AdoBoardService {
  private readonly logger = new Logger(AdoBoardService.name);

  constructor(
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
    private readonly client: AdoClientService,
    private readonly jobs: JobsService,
    private readonly projects: ProjectsService,
    private readonly sprints: SprintService,
  ) {}

  async getBoard(projectId: string): Promise<Board> {
    /*
     * **Every** plan, not the active one.
     *
     * The board shows a product's whole development, and once a project can hold an initial plan
     * plus enhancements, that work is spread across several. Reading only the newest would make the
     * original backlog's cards vanish from the board the moment an enhancement was started.
     */
    const drafts = await allDrafts(this.draftModel, projectId);
    if (drafts.length === 0) {
      throw new NotFoundException('No planning draft for this project.');
    }
    const project = await this.projects.findById(projectId);

    const plannedIds = drafts
      .flatMap((d) => d.backlog.map((i) => i.adoId))
      .filter((id): id is number => typeof id === 'number');
    // Bugs are raised by QA *after* planning, so they are never in the draft backlog — but they are
    // work a Developer agent picks up, so the board has to go and find them (D-019, D-028).
    const bugIds = await this.bugIds(
      project.adoTarget.project,
      project.adoTarget.areaPath,
      project.id as string,
    );
    const ids = [...new Set([...plannedIds, ...bugIds])];
    const [workItems, agentRunning, jobs, sprintContext] = await Promise.all([
      ids.length > 0
        ? this.client.for(projectId).getWorkItemsBatch(ids, BOARD_FIELDS)
        : Promise.resolve([]),
      this.jobs.activeDeveloperWorkItemIds(),
      this.jobs.listForProject(projectId),
      this.sprints.getContext(project.adoTarget.project, project.id as string),
    ]);

    const latestRuns = AdoBoardService.latestDeveloperRunByWorkItem(jobs);
    const tasks = [
      ...AdoBoardService.tasksFromAdo(workItems, agentRunning, {
        project,
        sprintContext,
        latestRuns,
      }),
      /*
       * One plan at a time, deliberately.
       *
       * Draft ids are only unique *within* a plan — two plans can each hold a `story-1-1`. Merging
       * the backlogs before resolving the hierarchy would let an enhancement's Task attach itself to
       * the original plan's Story of the same id, and the board would show a parent that is not its
       * parent. Resolving each plan on its own and concatenating the cards cannot do that.
       */
      ...drafts.flatMap((d) => AdoBoardService.tasksFromDraft(d.backlog, project)),
    ];
    return {
      // "Has anything of this product reached Azure DevOps?" — which is what the empty-board message
      // asks. An enhancement still being planned must not make the board claim nothing was pushed.
      pushed: drafts.some((d) => d.approval.pushedToAdo),
      currentSprint: sprintContext.currentSprint,
      columns: AdoBoardService.groupByStatus(tasks),
    };
  }

  /**
   * Bug ids under the project's area path. Best-effort: a board that cannot list Bugs still shows
   * every planned Task rather than failing outright.
   */
  private async bugIds(adoProject: string, areaPath: string, owner: string): Promise<number[]> {
    try {
      const escaped = areaPath.replace(/'/g, "''");
      return await this.client
        .for(owner)
        .queryWorkItemIds(
          adoProject,
          `SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER '${escaped}' ` +
            `AND [System.WorkItemType] = 'Bug'`,
        );
    } catch (err) {
      this.logger.warn(`Could not list Bugs for the board: ${(err as Error).message}`);
      return [];
    }
  }

  /** Newest Developer run per work item (the jobs list is already newest-first). */
  static latestDeveloperRunByWorkItem(jobs: JobDocument[]): Map<string, JobDocument> {
    const latest = new Map<string, JobDocument>();
    for (const job of jobs) {
      if (job.role !== JobRole.Developer || !job.workItemId) continue;
      if (!latest.has(job.workItemId)) latest.set(job.workItemId, job);
    }
    return latest;
  }

  /** Projects the fetched ADO work items down to Task cards, each carrying its resolved hierarchy. */
  static tasksFromAdo(
    workItems: AdoWorkItem[],
    agentRunning: ReadonlySet<string>,
    ctx: {
      project: ProjectDocument;
      sprintContext: SprintContext;
      latestRuns: ReadonlyMap<string, JobDocument>;
    },
  ): BoardTask[] {
    const byId = new Map<string, HierarchyNode>();
    for (const wi of workItems) {
      const type = String(wi.fields['System.WorkItemType'] ?? '');
      const parent = wi.fields['System.Parent'];
      byId.set(String(wi.id), {
        parentId: typeof parent === 'number' ? String(parent) : null,
        kind: kindOfAdoType(type),
        repoTags: parseRepoTags(String(wi.fields['System.Tags'] ?? '')),
        ref: {
          adoId: wi.id,
          title: String(wi.fields['System.Title'] ?? ''),
          state: String(wi.fields['System.State'] ?? '') || null,
        },
      });
    }

    const tasks: BoardTask[] = [];
    for (const wi of workItems) {
      const cardKind = cardKindOfAdoType(String(wi.fields['System.WorkItemType'] ?? ''));
      if (!cardKind) continue;
      const state = String(wi.fields['System.State'] ?? '');
      const rawStatus = normalizeTaskState(state);
      if (!rawStatus) continue; // Removed / cancelled work is not shown
      const hasActiveExecution = agentRunning.has(String(wi.id));

      // One shared rule, so the column, the Fix button and the dispatch cannot disagree.
      const status = effectiveBoardStatus(cardKind, rawStatus, hasActiveExecution);

      const node = byId.get(String(wi.id));
      const ancestors = resolveAncestors(node?.parentId ?? null, byId);
      // Its own tag wins; a child with none inherits the nearest ancestor's.
      const ownRepoTags = parseRepoTags(String(wi.fields['System.Tags'] ?? ''));
      const repoTag = ownRepoTags.length
        ? ownRepoTags
        : inheritedRepoTags(node?.parentId ?? null, byId);
      const sprintPath =
        typeof wi.fields['System.IterationPath'] === 'string'
          ? (wi.fields['System.IterationPath'] as string)
          : null;
      const sprint = sprintLeaf(sprintPath);
      const sprintTimeFrame = SprintService.classify(sprintPath, ctx.sprintContext);
      const executionAgent = resolveExecutionAgent(ctx.project.targetRepos, repoTag);
      const job = ctx.latestRuns.get(String(wi.id));

      tasks.push({
        kind: cardKind,
        adoId: wi.id,
        key: String(wi.id),
        title: String(wi.fields['System.Title'] ?? ''),
        description: String(wi.fields['System.Description'] ?? ''),
        acceptanceCriteria: String(wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? ''),
        state,
        status,
        sprint,
        sprintPath,
        sprintTimeFrame,
        assignee: assigneeName(wi.fields['System.AssignedTo']),
        updatedAt: wi.fields['System.ChangedDate'] ? String(wi.fields['System.ChangedDate']) : null,
        executionAgent,
        repo: resolveRepo(ctx.project.targetRepos, repoTag) ?? null,
        agentRunning: hasActiveExecution,
        execution: job ? toTaskExecution(job) : null,
        canTransition: AdoBoardService.availability({
          status,
          inAdo: true,
          kind: cardKind,
          sprintTimeFrame,
          currentSprint: ctx.sprintContext.currentSprint,
          taskSprint: sprint,
          executionAgent,
          hasActiveExecution,
          story: ancestors.story,
        }),
        ...ancestors,
      });
    }
    return tasks;
  }

  /**
   * Backlog Tasks that exist in the approved draft but have **not been created in ADO yet** — the
   * `Draft` column. Hierarchy comes from the local backlog tree, so these cards show the same
   * Epic → Feature → Story context as pushed Tasks.
   */
  static tasksFromDraft(backlog: BacklogItem[], project: ProjectDocument): BoardTask[] {
    const byId = new Map<string, HierarchyNode>();
    for (const item of backlog) {
      byId.set(item.id, {
        parentId: item.parentId,
        kind: kindOfBacklogType(item.type),
        // A draft item carries its repo as a field, not a tag; same information, same shape.
        repoTags: item.repo ? [item.repo] : [],
        ref: { adoId: item.adoId ?? null, title: item.title, state: null },
      });
    }
    return backlog
      .filter((item) => item.type === BacklogItemType.Task && item.adoId == null)
      .map((item) => {
        const ancestors = resolveAncestors(item.parentId, byId);
        const executionAgent = resolveExecutionAgent(project.targetRepos, item.repo);
        return {
          // A draft backlog item is always a planned Task; Bugs only exist once QA files them.
          kind: 'task' as const,
          adoId: null,
          key: item.id,
          title: item.title,
          description: item.description ?? '',
          acceptanceCriteria: item.acceptanceCriteria ?? '',
          state: null,
          status: 'Draft' as TaskStatus,
          sprint: item.sprint,
          sprintPath: item.sprint,
          sprintTimeFrame: 'unknown' as SprintTimeFrame,
          assignee: null,
          updatedAt: null,
          executionAgent,
          repo: item.repo,
          agentRunning: false,
          execution: null,
          canTransition: AdoBoardService.availability({
            status: 'Draft',
            inAdo: false,
            sprintTimeFrame: 'unknown',
            currentSprint: null,
            taskSprint: item.sprint,
            executionAgent,
            hasActiveExecution: false,
            story: ancestors.story,
          }),
          ...ancestors,
        };
      });
  }

  /** Runs the shared transition rules for a card's single forward move. */
  private static availability(input: {
    status: TaskStatus;
    inAdo: boolean;
    kind?: 'task' | 'bug';
    sprintTimeFrame: SprintTimeFrame;
    currentSprint: string | null;
    taskSprint: string | null;
    executionAgent: string | null;
    hasActiveExecution: boolean;
    story: WorkItemRef | null;
  }): TransitionAvailability {
    const to = nextStatus(input.status);
    if (!to) return { to: null, allowed: false };
    const verdict = validateTaskTransition({
      from: input.status,
      to,
      inAdo: input.inAdo,
      kind: input.kind ?? 'task',
      sprintTimeFrame: input.sprintTimeFrame,
      currentSprint: input.currentSprint,
      taskSprint: input.taskSprint,
      executionAgent: input.executionAgent,
      hasActiveExecution: input.hasActiveExecution,
      parentStoryApproved: input.story?.state
        ? APPROVED_PARENT_STATES.has(input.story.state.trim().toLowerCase())
        : null,
      hasParentStory: Boolean(input.story),
    });
    return { to, allowed: verdict.ok, reason: verdict.reason, hint: verdict.hint };
  }

  /**
   * Buckets Tasks into the fixed `Draft → To Do → In Progress → Done` columns. Every column is
   * returned even when empty so the workflow stays readable, and cards are ordered by ADO id — the
   * same order the Developer batch dispatches them in (`ORDER BY [System.Id] ASC`).
   */
  static groupByStatus(tasks: BoardTask[]): BoardColumn[] {
    return TASK_COLUMNS.map((status) => ({
      status,
      tasks: tasks
        .filter((t) => t.status === status)
        .sort(
          (a, b) => (a.adoId ?? Number.MAX_SAFE_INTEGER) - (b.adoId ?? Number.MAX_SAFE_INTEGER),
        ),
    }));
  }
}

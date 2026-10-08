import { SprintTimeFrame } from '../ado/sprint.service';

/** The normalized Development-board statuses. */
export type BoardStatus = 'Draft' | 'To Do' | 'In Progress' | 'Done';

/**
 * The **only** forward transitions the workflow supports. Anything else (Draft → Done,
 * To Do → Done, In Progress → To Do, Done → …) is rejected. `In Progress → Done` is absent on
 * purpose: the orchestrator sets Done after a successful Developer Agent run, never a user.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<BoardStatus, readonly BoardStatus[]>> = {
  Draft: ['To Do'],
  'To Do': ['In Progress'],
  'In Progress': [],
  Done: [],
};

/** The execution agent the orchestrator dispatches for development work. */
export const CLAUDE_DEVELOPER = 'Claude Developer';

/** What a board key resolves to. Only `task` and `bug` are work an agent can execute. */
export type WorkItemKind = 'task' | 'bug' | 'other';

/** Classifies an Azure DevOps work-item type name into a {@link WorkItemKind}. */
export function workItemKindOf(type: string): WorkItemKind {
  const raw = type.trim().toLowerCase();
  if (raw === 'task') return 'task';
  if (raw === 'bug') return 'bug';
  return 'other';
}

/** Everything the rules need to judge one Task's transition. Gathered by the caller, never fetched here. */
export interface TransitionContext {
  from: BoardStatus;
  to: BoardStatus;
  /** False while the Task is still an unpushed draft backlog item. */
  inAdo: boolean;
  /**
   * What the work item is. Developer agents act on **Tasks** (new work) and **Bugs** (QA-found
   * defects, D-019); anything else — a Story, a Feature — is not something an agent implements.
   */
  kind: WorkItemKind;
  /** ADO's classification of the Task's iteration. `unknown` never blocks. */
  sprintTimeFrame: SprintTimeFrame;
  /** Active sprint name, for the message. */
  currentSprint: string | null;
  /** The Task's own sprint, for the message. */
  taskSprint: string | null;
  /** Resolved execution agent (null when no target repo resolves for the Task). */
  executionAgent: string | null;
  /** True when a Developer run is already in flight for this Task. */
  hasActiveExecution: boolean;
  /**
   * Whether the parent Story is approved for work (Approved/Committed). `null` when unknown —
   * treated as "do not block" so a missing read never wedges the board.
   */
  parentStoryApproved: boolean | null;
  /** False when the Task has no parent Story at all. */
  hasParentStory: boolean;
}

export interface TransitionVerdict {
  ok: boolean;
  /** Why the transition is blocked — surfaced verbatim in the UI and the audit trail. */
  reason?: string;
  /** What the user can do about it, when there is a sensible next step. */
  hint?: string;
}

const OK: TransitionVerdict = { ok: true };

/**
 * Where a work item really stands, once the live run is taken into account.
 *
 * `Committed` on a Bug is written by the orchestrator when it dispatches a pod, so it reads as
 * In Progress. A QA agent rejecting a fix reopens the Bug to `Committed` too — and then nothing is
 * running. Bug #628 sat in the In Progress column for ten hours, unactionable, because the column
 * was read from a state that had stopped being true.
 *
 * This lives here, beside the rules, because three separate places answer this question — the board
 * column, the Fix button on the QA card, and the transition that actually dispatches. The first two
 * were fixed one at a time while the third kept refusing, so the rule is now written once.
 */
export function effectiveBoardStatus(
  kind: 'task' | 'bug' | 'other',
  rawStatus: BoardStatus,
  hasActiveExecution: boolean,
): BoardStatus {
  return kind === 'bug' && rawStatus === 'In Progress' && !hasActiveExecution ? 'To Do' : rawStatus;
}

/**
 * **The single source of truth for Task transition rules.** Drag-and-drop, the card action buttons,
 * bulk actions and the backend API all evaluate this same function, so they can never disagree.
 * Pure — it makes no I/O and no state changes; the caller gathers the context and applies the
 * result.
 */
export function validateTaskTransition(ctx: TransitionContext): TransitionVerdict {
  if (ctx.from === ctx.to) {
    return { ok: false, reason: `This Task is already in ${ctx.to}.` };
  }

  // Done is never user-driven, whatever the source column.
  if (ctx.to === 'Done') {
    return {
      ok: false,
      reason: 'Done is set by the orchestrator, not manually.',
      hint: 'A Task moves to Done automatically once its Claude Developer Agent run completes successfully.',
    };
  }

  if (!ALLOWED_TRANSITIONS[ctx.from]?.includes(ctx.to)) {
    return {
      ok: false,
      reason: `${ctx.from} → ${ctx.to} is not a supported transition.`,
      hint: 'The development flow is Draft → To Do → In Progress → Done.',
    };
  }

  if (ctx.kind === 'other') {
    return { ok: false, reason: 'Only Tasks and Bugs can be dispatched to a Developer Agent.' };
  }

  if (ctx.to === 'To Do') return validateApproval(ctx);
  return validateStartDevelopment(ctx);
}

/** `Draft → To Do` — approving a drafted Task for development. */
function validateApproval(ctx: TransitionContext): TransitionVerdict {
  if (ctx.inAdo) {
    return {
      ok: false,
      reason: 'This Task is already in Azure DevOps.',
      hint: 'Refresh the board to see its current status.',
    };
  }
  return OK;
}

/** `To Do → In Progress` — dispatching the Claude Developer Agent. */
function validateStartDevelopment(ctx: TransitionContext): TransitionVerdict {
  if (!ctx.inAdo) {
    return {
      ok: false,
      reason: 'This Task is not in Azure DevOps yet.',
      hint: 'Approve it for development first (Draft → To Do).',
    };
  }

  if (ctx.hasActiveExecution) {
    return {
      ok: false,
      reason: 'This Task already has an active Developer Agent execution.',
      hint: 'Wait for the current run to finish, or open the Task to view its execution.',
    };
  }

  // A future-sprint Task may be planned and approved, but must not be started.
  if (ctx.sprintTimeFrame === 'future') {
    const taskSprint = ctx.taskSprint ?? 'a future sprint';
    const current = ctx.currentSprint ? `${ctx.currentSprint} is currently active.` : '';
    return {
      ok: false,
      reason: `This Task belongs to ${taskSprint}. ${current}`.trim(),
      hint: `Wait until ${taskSprint} becomes the active sprint.`,
    };
  }

  if (!ctx.executionAgent) {
    return {
      ok: false,
      reason: 'No execution agent is assigned to this Task.',
      hint: 'A target repository must resolve for the Task before the Claude Developer Agent can run it.',
    };
  }

  // A Bug is raised against work that is already under way, and QA may link it to its Story as a
  // related item rather than a parent — so the parent checks below are a Task-only concern.
  if (ctx.kind === 'bug') {
    return OK;
  }

  if (!ctx.hasParentStory) {
    return {
      ok: false,
      reason: 'This Task has no parent Story, so its context cannot be verified.',
    };
  }

  if (ctx.parentStoryApproved === false) {
    return {
      ok: false,
      reason: 'The parent Story is not approved for development yet.',
      hint: 'Approve the Story in Azure DevOps (Approved or Committed), then start development.',
    };
  }

  return OK;
}

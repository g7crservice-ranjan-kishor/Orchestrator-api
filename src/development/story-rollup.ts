/**
 * Pure rules for **Task → Story rollup**: the transition that turns finished development into
 * *Ready for QA*. A Story's state is never edited by hand on the board, and QA is triggered by the
 * Story reaching `Done` — so without this rule no Story ever becomes testable (WORKFLOW.md §3,
 * TESTING_STRATEGY §1A scenario 4, D-028).
 *
 * Kept free of ADO plumbing so the decision — *should this Story move, and to what* — is unit-tested
 * on its own.
 */

/** Scrum Product Backlog Item states, in order. */
export const STORY_STATE = {
  new: 'New',
  approved: 'Approved',
  /** Development under way — set when the Story's first Task starts. */
  committed: 'Committed',
  /** Development complete = **Ready for QA**. */
  done: 'Done',
} as const;

const DONE = STORY_STATE.done.toLowerCase();

/** A child work item of a Story, as the rollup sees it. */
export interface StoryChild {
  id: number;
  /** ADO work-item type, e.g. `Task`, `Bug`. */
  type: string;
  state: string;
}

const isType = (child: StoryChild, type: string): boolean =>
  child.type.trim().toLowerCase() === type;

const isDone = (child: StoryChild): boolean => child.state.trim().toLowerCase() === DONE;

/** The Story's Tasks (the work that must finish) and Bugs (defects that must not still be open). */
export function partitionChildren(children: readonly StoryChild[]): {
  tasks: StoryChild[];
  bugs: StoryChild[];
} {
  return {
    tasks: children.filter((c) => isType(c, 'task')),
    bugs: children.filter((c) => isType(c, 'bug')),
  };
}

/** Why a Story was not promoted — surfaced in the audit trail so a no-op is explainable. */
export type RollupSkipReason =
  'already-done' | 'no-tasks' | 'tasks-outstanding' | 'open-bugs' | 'not-promotable';

export type RollupDecision =
  { promote: true; to: string } | { promote: false; reason: RollupSkipReason };

/**
 * Whether a Story whose Task just completed should move to **Done (Ready for QA)**.
 *
 * Promotes only when every Task under the Story is Done **and no linked Bug is still open**. That
 * second condition is what stops the rollup from fighting QA: when QA fails a Story it reopens it to
 * `Committed` and files a Bug, and without the guard the next Task completion would silently shove
 * the Story back to Done while the defect is unfixed.
 *
 * A Story with **no Tasks** is never promoted — "all zero Tasks are Done" is not evidence that
 * anything was built.
 */
export function decideStoryCompletion(
  storyState: string,
  children: readonly StoryChild[],
): RollupDecision {
  const current = storyState.trim().toLowerCase();
  if (current === DONE) {
    return { promote: false, reason: 'already-done' };
  }
  const { tasks, bugs } = partitionChildren(children);
  if (tasks.length === 0) {
    return { promote: false, reason: 'no-tasks' };
  }
  if (!tasks.every(isDone)) {
    return { promote: false, reason: 'tasks-outstanding' };
  }
  if (bugs.some((bug) => !isDone(bug))) {
    return { promote: false, reason: 'open-bugs' };
  }
  return { promote: true, to: STORY_STATE.done };
}

/**
 * Whether a Story should move to **Committed** because development just started on one of its Tasks.
 * Only moves forward from `New`/`Approved`; a Story already Committed (or reopened there by QA) is
 * left alone, and a Done Story is never pulled backwards by a Task starting.
 */
export function decideStoryStart(storyState: string): RollupDecision {
  const current = storyState.trim().toLowerCase();
  if (current === STORY_STATE.new.toLowerCase() || current === STORY_STATE.approved.toLowerCase()) {
    return { promote: true, to: STORY_STATE.committed };
  }
  return { promote: false, reason: 'not-promotable' };
}

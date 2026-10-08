/**
 * Verified Azure DevOps work-item state model for the QA path (WORKFLOW.md §3, Task 18397).
 *
 * Confirmed against the **NQAI-DevAutomation** process template on 2026-08-03 via the work-item-type
 * metadata (`GET .../wit/workItemTypes/Bug`). Encoded here as constants so enumeration, the bug
 * loop, and the board all read one source of truth — the **real** state names, not the aspirational
 * KB shorthand ("Resolved"/"Closed").
 *
 * - **Story (Product Backlog Item):** `New → Approved → Committed → Done`.
 * - **Bug:** `New → Committed → Done`, plus `Re-Opened` for a QA-rejected fix. There is **no
 *   `Resolved` and no `Closed` state** in this project — `Done` is the sole Completed-category state.
 *   A developer-fixed Bug awaiting retest and a QA-verified Bug therefore both live in `Done` (the
 *   project's single analogue of the framework's Resolved/Closed pair) — they are told apart by the
 *   `qa-verified` tag (D-025), and re-dispatch of an item already under test is prevented by the
 *   one-active-run guard rather than by a distinct "awaiting retest" state.
 */

/** ADO work-item type names (Scrum process). The framework "User Story" is a Product Backlog Item. */
export const STORY_TYPE = 'Product Backlog Item';
export const BUG_TYPE = 'Bug';

/** Story (PBI) states used by the QA loop. */
export const STORY_STATE = {
  /** PBI Done = "development complete / Ready for QA" — the trigger a QA pod tests (WORKFLOW.md §3). */
  readyForQa: 'Done',
  /** On a failed test QA reopens the Story here (Done → Committed), per D-019. */
  reopen: 'Committed',
} as const;

/** Bug states used by the QA loop — the **verified** project names (there is no Resolved/Closed). */
export const BUG_STATE = {
  /** QA files a Bug here, assigned to the Developer. */
  filed: 'New',
  /** Developer sets this when starting the fix (InProgress category). */
  fixing: 'Committed',
  /** Developer fix complete, awaiting QA retest — this project's analogue of "Resolved". */
  awaitingRetest: 'Done',
  /** QA pass keeps the Bug Done (no separate Closed state); a comment records the verification. */
  verified: 'Done',
  /** QA fail bounces the Bug back to the Developer (Done → Committed) + reassign (WORKFLOW.md §3). */
  rejected: 'Committed',
} as const;

/** One (type, state) pair that makes a work item ready for a QA pod. */
export interface QaReadySignal {
  type: string;
  state: string;
}

/**
 * A work item is ready for a QA pod when a **Story is Done** (Ready for QA) or a **Bug is awaiting
 * retest** (developer-fixed). Enumeration and per-item eligibility both derive from this list, so
 * the "what does QA pick up" rule lives in exactly one place.
 */
export const QA_READY: readonly QaReadySignal[] = [
  { type: STORY_TYPE, state: STORY_STATE.readyForQa },
  { type: BUG_TYPE, state: BUG_STATE.awaitingRetest },
];

/** Classifies a QA-ready work item so the pod knows whether it is testing a Story or retesting a Bug. */
export type QaItemKind = 'story' | 'bug';

/** Returns the QA item kind for an ADO work-item type, or null if the type is not QA-testable. */
export function qaItemKind(workItemType: string): QaItemKind | null {
  if (workItemType === STORY_TYPE) {
    return 'story';
  }
  if (workItemType === BUG_TYPE) {
    return 'bug';
  }
  return null;
}

/** True when a (type, state) pair matches a QA-ready signal. */
export function isQaReady(workItemType: string, state: string): boolean {
  return QA_READY.some((r) => r.type === workItemType && r.state === state);
}

/**
 * Tag a QA pod adds to any work item it **passed** (D-025, extended to Stories in D-028).
 *
 * Enumeration selects Stories and Bugs in `Done` — and a passing QA leaves them in `Done`. So the
 * tag is the only thing separating "finished development, needs testing" from "already tested and
 * passed"; without it every `Start QA` re-dispatches a pod for everything that ever passed and the
 * QA leg never converges. Cleared when development reopens the item (Story → `Committed`) or when a
 * retest fails, so the next `Done` is tested afresh.
 */
export const QA_VERIFIED_TAG = 'qa-verified';

/** True when ADO's semicolon-delimited tag string carries {@link QA_VERIFIED_TAG}. */
export function hasQaVerifiedTag(tags: string | null | undefined): boolean {
  return (tags ?? '').split(';').some((tag) => tag.trim().toLowerCase() === QA_VERIFIED_TAG);
}

/** A single test-point outcome recorded during a QA run (WORKFLOW.md §3, D-020). */
export type TestOutcome = 'Passed' | 'Failed' | 'Blocked';

/** Aggregate QA verdict for a Story from its test-point outcomes. */
export type QaVerdict = 'pass' | 'fail' | 'blocked';

/**
 * Aggregates test-point outcomes into a Story verdict (the fail path triggers on any Failed point).
 * Precedence: **any Failed → fail** (file a Bug + reopen the Story); else **any Blocked → blocked**
 * (leave the Story Done, no Bug — a Blocked point is not a defect); else **pass**. An empty set is
 * treated as `blocked` (nothing was actually verified), never a silent pass.
 */
export function verdictFromOutcomes(outcomes: readonly TestOutcome[]): QaVerdict {
  if (outcomes.length === 0) {
    return 'blocked';
  }
  if (outcomes.includes('Failed')) {
    return 'fail';
  }
  if (outcomes.includes('Blocked')) {
    return 'blocked';
  }
  return 'pass';
}

/**
 * Target Story (PBI) state after a QA run given the verdict. A **fail reopens** the Story
 * `Done → Committed` (D-019); pass/blocked leave it **Done**. The work-item state remains the
 * authoritative pass/fail signal the board reads.
 */
export function storyStateAfterQa(verdict: QaVerdict): string {
  return verdict === 'fail' ? STORY_STATE.reopen : STORY_STATE.readyForQa;
}

/** Result of retesting a developer-fixed Bug: its next state + whether to reassign the Developer. */
export interface BugRetestTransition {
  state: string;
  reassignDeveloper: boolean;
}

/**
 * Target Bug transition after a QA **retest** (WORKFLOW.md §3, D-019): **pass** verifies/closes the
 * Bug (stays `Done`, no reassign); **fail** reopens it `Done → Committed` and reassigns the
 * Developer. There is no separate Closed state in this project, so a verified Bug stays `Done`.
 */
export function bugStateAfterRetest(verdict: 'pass' | 'fail'): BugRetestTransition {
  return verdict === 'pass'
    ? { state: BUG_STATE.verified, reassignDeveloper: false }
    : { state: BUG_STATE.rejected, reassignDeveloper: true };
}

/** Bug states that count as **closed** for the release gate (Completed/Removed categories). */
const CLOSED_BUG_STATES = new Set([BUG_STATE.verified, 'Removed']);
/** Severities that block a release when still open (Scrum severity strings). */
const BLOCKING_SEVERITIES = new Set(['1 - Critical', '2 - High']);

/** A Bug as seen by the pre-release closure gate. */
export interface BugStatus {
  state: string;
  severity: string;
}

/** True when a Bug is **open** (not yet Done/Removed). */
export function isBugOpen(bug: BugStatus): boolean {
  return !CLOSED_BUG_STATES.has(bug.state);
}

/** True when an **open** Bug is High or Critical severity — the release-blocking condition (D-010). */
export function isBlockingBug(bug: BugStatus): boolean {
  return isBugOpen(bug) && BLOCKING_SEVERITIES.has(bug.severity);
}

/**
 * Pre-release / end-of-sprint closure gate (D-010): a sprint/release may complete only when **no
 * open High/Critical Bug remains**. Low-severity cosmetic Bugs may trail into the next sprint, so
 * they do not block. Returns true when it is safe to close.
 */
export function canClosePreRelease(bugs: readonly BugStatus[]): boolean {
  return !bugs.some(isBlockingBug);
}

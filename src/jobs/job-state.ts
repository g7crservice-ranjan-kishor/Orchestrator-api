/**
 * Jobs-table lifecycle (ARCHITECTURE.md §5):
 *   Queued → Claimed → Running → Completed | Cancelled | Failed | Blocked
 * `Blocked` is not a failure — it covers external/human-gate waits and can resume to Running.
 * A job may be Cancelled from any non-terminal state; an expired lease returns Running/Claimed
 * jobs to Queued for re-dispatch (retry, not resume).
 */
export enum JobState {
  Queued = 'Queued',
  Claimed = 'Claimed',
  Running = 'Running',
  Completed = 'Completed',
  Cancelled = 'Cancelled',
  Failed = 'Failed',
  Blocked = 'Blocked',
}

/** AI roles that can run as a job. Phase 1 dispatches only `em` and `sm`. */
export enum JobRole {
  EM = 'em',
  SM = 'sm',
  Developer = 'developer',
  QA = 'qa',
  /** Runs the whole product and reports whether it works. Uses no agent and no tokens. */
  Verify = 'verify',
}

export enum PermissionMode {
  Plan = 'plan',
  BypassPermissions = 'bypassPermissions',
}

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  JobState.Completed,
  JobState.Cancelled,
  JobState.Failed,
]);

/** Non-terminal states count as an "active run" for the one-active-run-per-work-item guard. */
export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Allowed forward transitions. Cancellation is handled separately (any non-terminal → Cancelled). */
const ALLOWED: Record<JobState, ReadonlySet<JobState>> = {
  // Failed is reachable from Queued because a run can be abandoned before any pod claims it:
  // lease-reclaim gives up on a run whose pods keep dying, and that run is Queued at the moment it
  // is written off. Without this it stayed Queued for ever — the give-up was rejected, the
  // rejection was swallowed by the scheduler, and the board went on showing a run going nowhere.
  [JobState.Queued]: new Set([JobState.Claimed, JobState.Failed, JobState.Cancelled]),
  [JobState.Claimed]: new Set([
    JobState.Running,
    JobState.Queued,
    JobState.Failed,
    JobState.Cancelled,
  ]),
  [JobState.Running]: new Set([
    JobState.Completed,
    JobState.Failed,
    JobState.Blocked,
    JobState.Queued,
    JobState.Cancelled,
  ]),
  [JobState.Blocked]: new Set([JobState.Running, JobState.Failed, JobState.Cancelled]),
  [JobState.Completed]: new Set(),
  [JobState.Cancelled]: new Set(),
  [JobState.Failed]: new Set([JobState.Queued]), // retry with backoff
};

/** Returns true if `to` is a permitted transition from `from`. */
export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED[from]?.has(to) ?? false;
}

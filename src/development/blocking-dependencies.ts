/**
 * Whether the work a Task waits for is finished.
 *
 * The failure this prevents: an enhancement Task — "add a dark mode toggle to the Settings page" —
 * is dispatched while **Build the Settings page** is still in To Do. The agent opens the code,
 * finds no Settings page, and either fails or builds its own. Later the original Task runs and
 * builds a second one. Two Settings pages, both half right, and nothing on the board explains it.
 *
 * So a Task whose dependencies are unfinished is not refused outright and not retried in a loop —
 * it is **skipped**, and the queue moves on to something that can run. It becomes eligible on its
 * own the moment the work it waits for reaches Done.
 */

/** One dependency, as the board needs to talk about it. */
export interface DependencyState {
  id: number;
  title: string;
  state: string;
}

/**
 * States in which a dependency no longer holds anything up.
 *
 * `Removed` counts as finished deliberately: work that has been cancelled is never going to reach
 * Done, and treating it as a blocker would strand everything behind it forever.
 */
const SETTLED = new Set(['done', 'closed', 'removed']);

export function isSettled(state: string): boolean {
  return SETTLED.has((state ?? '').trim().toLowerCase());
}

/** The dependencies that are not finished yet, in the order they were given. */
export function unsettled(dependencies: DependencyState[]): DependencyState[] {
  return dependencies.filter((dependency) => !isSettled(dependency.state));
}

/**
 * The phrase that marks a refusal as "not yet" rather than "not ever".
 *
 * The queue has to tell the two apart. A Task waiting on a dependency stays **Queued** — it becomes
 * startable on its own the moment the blocker is Done — while a Task that can never start is marked
 * terminal so the queue stops reconsidering it. One constant, written by {@link blockedReason} and
 * read by {@link isWaitingReason}, so the two can never drift apart; a test pins that they agree.
 */
export const WAITING_MARKER = 'is waiting for work that is not finished';

/** Whether a refusal means "not yet". */
export function isWaitingReason(reason: string | null | undefined): boolean {
  return (reason ?? '').includes(WAITING_MARKER);
}

/**
 * Why a Task cannot start yet, or null when nothing is holding it up.
 *
 * Names the blocker rather than the count: "waiting for #790" is something a person can act on,
 * "1 dependency unmet" is not. More than two are summarised, because a reason nobody reads to the
 * end is a reason nobody uses.
 */
export function blockedReason(
  workItemId: string | number,
  dependencies: DependencyState[],
): string | null {
  const waiting = unsettled(dependencies);
  if (waiting.length === 0) return null;

  const named = waiting
    .slice(0, 2)
    .map((dependency) => `#${dependency.id} "${dependency.title}" (${dependency.state})`)
    .join(', ');
  const rest = waiting.length > 2 ? ` and ${waiting.length - 2} more` : '';
  return (
    `Task ${workItemId} ${WAITING_MARKER}: ${named}${rest}. ` +
    'It will start on its own once that is Done.'
  );
}

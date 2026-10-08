import { AdoIteration } from './ado-client.service';

/**
 * Turning the sprints an agent *writes* into the sprints a project *has*.
 *
 * **The failure this prevents.** A Scrum Master always numbers from one — "Sprint 1", "Sprint 2" —
 * because it is planning a body of work, not reading a calendar. That is right for a first build,
 * where Sprint 1 is genuinely next. For an enhancement it is wrong in the worst way: on the Employee
 * Management System, Sprint 1 closed on 30 September, so ENH-001's work would be created inside a
 * sprint that ended weeks ago — present in Azure DevOps, absent from the board, picked up by
 * nothing. Exactly the shape of the earlier "why is the active sprint 5 instead of 1" problem.
 *
 * So the agent decides **order** and the orchestrator decides **when**. Its relative Sprint 1 lands
 * on the project's anchor sprint, relative Sprint 2 on the one after, and so on. The ordering gates
 * are untouched, because they compare numbers and the numbers keep their order.
 */

/** Where an enhancement's first sprint lands. */
export type SprintAnchor = 'current' | 'next';

export interface SprintPlan {
  /** Relative sprint name, as written in the backlog → the real sprint it becomes. */
  mapping: ReadonlyMap<string, string>;
  /** Relative sprints the project has no sprint for; these have to be created. */
  missing: string[];
  /** The sprint relative Sprint 1 landed on, for saying what happened. */
  anchorName: string | null;
}

/** The sprint number in a name like "Sprint 3", or null when it is not numbered that way. */
export function sprintNumberOf(name: string | null | undefined): number | null {
  const digits = /(\d+)/.exec(name ?? '');
  return digits ? Number(digits[1]) : null;
}

/**
 * Where the first sprint of an enhancement belongs.
 *
 * `current` is the default and the usual answer: an enhancement is normally wanted now, and work
 * that cannot start until the next rollover is work nobody is doing. `next` is for a team that
 * keeps its sprint boundaries clean and would rather not have a burndown jump mid-sprint.
 *
 * Falls back to the first future sprint when nothing is current — a project between sprints still
 * has to be able to schedule — and to the very first sprint when there is no dating at all.
 */
export function anchorIndex(iterations: readonly AdoIteration[], anchor: SprintAnchor): number {
  if (iterations.length === 0) return -1;

  const current = iterations.findIndex((i) => i.timeFrame === 'current');
  const future = iterations.findIndex((i) => i.timeFrame === 'future');

  const start = current >= 0 ? current : future >= 0 ? future : 0;
  if (anchor === 'next') {
    // The sprint after the one in flight — or, between sprints, the first future one as it stands.
    return current >= 0 ? current + 1 : start;
  }
  return start;
}

/**
 * Maps the sprints a backlog names onto the project's real ones.
 *
 * `sprints` are the names the backlog uses, in any order and with repeats; `iterations` are the
 * project's own, in Azure DevOps' backlog order. Relative numbering is honoured as *order*, not as
 * arithmetic: a backlog that jumps from Sprint 1 to Sprint 3 gets two consecutive sprints, because
 * what it meant was "and then", not "leave a gap".
 *
 * A name with no number in it is passed through untouched — a project that names its sprints some
 * other way is left alone rather than guessed at.
 */
export function planSprints(
  sprints: readonly (string | null | undefined)[],
  iterations: readonly AdoIteration[],
  anchor: SprintAnchor = 'current',
): SprintPlan {
  const numbered = [
    ...new Set(sprints.filter((s): s is string => sprintNumberOf(s) !== null)),
  ].sort((a, b) => (sprintNumberOf(a) as number) - (sprintNumberOf(b) as number));

  const from = anchorIndex(iterations, anchor);
  const mapping = new Map<string, string>();
  const missing: string[] = [];

  numbered.forEach((relative, position) => {
    const target = from >= 0 ? iterations[from + position] : undefined;
    if (target) {
      mapping.set(relative, target.name);
    } else {
      missing.push(relative);
    }
  });

  return {
    mapping,
    missing,
    anchorName: from >= 0 ? (iterations[from]?.name ?? null) : null,
  };
}

/**
 * Names for the sprints a project has to grow to fit an enhancement.
 *
 * Continues the project's own numbering rather than restarting: after `Sprint 6` comes `Sprint 7`.
 * Falls back to counting from the number of iterations when none of them are numbered, which is the
 * only thing left to do.
 */
export function newSprintNames(iterations: readonly AdoIteration[], count: number): string[] {
  const highest = iterations.reduce(
    (top, iteration) => Math.max(top, sprintNumberOf(iteration.name) ?? 0),
    iterations.length,
  );
  return Array.from({ length: Math.max(0, count) }, (_, i) => `Sprint ${highest + i + 1}`);
}

/** What the anchoring did, for the push report and the audit trail. */
export function describeSprintPlan(plan: SprintPlan): string {
  if (plan.mapping.size === 0) return 'No sprints were rescheduled.';
  const moved = [...plan.mapping.entries()]
    .filter(([relative, actual]) => relative !== actual)
    .map(([relative, actual]) => `${relative} → ${actual}`);
  if (moved.length === 0) return `Sprints already matched the project (from ${plan.anchorName}).`;
  return `Scheduled from ${plan.anchorName}: ${moved.join(', ')}.`;
}

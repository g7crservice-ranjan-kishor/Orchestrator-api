import { DraftDocument, DraftStatus } from './schemas/draft.schema';

/** What a planning run was supposed to leave behind, by the status it put the draft into. */
const AWAITING: Partial<Record<DraftStatus, { fallback: DraftStatus; expected: string }>> = {
  [DraftStatus.Planning]: { fallback: DraftStatus.Intake, expected: 'a plan' },
  [DraftStatus.BacklogDrafting]: { fallback: DraftStatus.Planned, expected: 'a backlog' },
};

/** Where a stalled draft should be left, and what to tell the reader. */
export interface StallOutcome {
  status: DraftStatus;
  message: string;
}

/**
 * Decides what to do when a planning run finishes without delivering anything.
 *
 * The failure this ends: a Scrum Master run completed cleanly — Kubernetes reported the Job done,
 * the container exited zero — but posted no backlog, so the draft sat in `backlogDrafting` for
 * ever. The screen honestly said "an agent is working" while nothing was working, and the only way
 * to find out was to read the database. A run that produces nothing is a failed run, and should
 * say so.
 *
 * Returns `null` when the run did deliver (the draft has already moved on), or when this is not
 * the run the draft is waiting for — a late event from an earlier run must not disturb a newer one.
 */
export function stalledOutcome(draft: DraftDocument, runId: string): StallOutcome | null {
  if (draft.currentRunId !== runId) return null;
  const awaiting = AWAITING[draft.status];
  if (!awaiting) return null;
  return {
    status: awaiting.fallback,
    message:
      `The agent run finished without producing ${awaiting.expected}. ` +
      'Nothing was changed. Start it again, or check the run output for what it returned.',
  };
}

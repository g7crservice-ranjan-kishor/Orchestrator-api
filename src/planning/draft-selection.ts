import { DraftKind, DraftStatus } from './schemas/draft.schema';

/**
 * Which of a project's plans a request is about.
 *
 * Nine places in the orchestrator say "the project's draft" and mean the only one there could be.
 * Once a project can have an initial plan plus any number of enhancements, each of them has to say
 * which — and almost all of them mean the same thing: *the one being worked on now*.
 *
 * The rule is deliberately simple, because an ambiguous answer here would send the push, the board
 * and the approval gate to three different plans:
 *
 * 1. The plan that is still being worked on, if there is one. Only one may be in flight at a time.
 * 2. Otherwise the most recent — highest `seq`.
 *
 * For a project with one plan it returns that plan, which is why every existing call site keeps
 * behaving exactly as it does today.
 */

/** The shape this module needs. The real document has far more on it. */
export interface DraftLike {
  kind: DraftKind;
  seq: number;
  status: DraftStatus;
  title?: string | null;
}

/** A plan nobody is still working on. Approved is the end of a planning cycle. */
export function isSettled(draft: DraftLike): boolean {
  return draft.status === DraftStatus.Approved;
}

/**
 * The plan a request about "this project" means, or null when the project has none.
 *
 * Ties on `seq` cannot happen — the compound unique index forbids them — but if the data were ever
 * repaired by hand, the later one wins, which matches the rule above.
 */
export function activeDraft<T extends DraftLike>(drafts: readonly T[]): T | null {
  if (drafts.length === 0) return null;
  const inFlight = drafts.filter((draft) => !isSettled(draft));
  const pool = inFlight.length > 0 ? inFlight : drafts;
  return [...pool].sort((a, b) => b.seq - a.seq)[0];
}

/**
 * Whether a new planning cycle may start.
 *
 * One at a time, for a plain reason: the agents, the backlog gates and both queues all act on "the
 * project's plan", and two unfinished plans would make that question unanswerable. A cycle ends at
 * Approved, which is also when its work reaches the board.
 */
export function unfinishedDraft<T extends DraftLike>(drafts: readonly T[]): T | null {
  return drafts.find((draft) => !isSettled(draft)) ?? null;
}

/** The next position in the project's planning history. Assigned once, never reused. */
export function nextSeq(drafts: readonly DraftLike[]): number {
  return drafts.reduce((highest, draft) => Math.max(highest, draft.seq), -1) + 1;
}

/** `ENH-001`. Counts enhancements, so the first one is 001 whatever its `seq`. */
export function enhancementRef(seq: number): string {
  return `ENH-${String(Math.max(1, seq)).padStart(3, '0')}`;
}

/** What a plan is called on screen. */
export function draftLabel(draft: DraftLike): string {
  if (draft.kind === DraftKind.Initial) return 'Initial plan';
  const ref = enhancementRef(draft.seq);
  return draft.title?.trim() ? `${ref} — ${draft.title.trim()}` : ref;
}

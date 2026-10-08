import {
  activeDraft,
  draftLabel,
  DraftLike,
  enhancementRef,
  isSettled,
  nextSeq,
  unfinishedDraft,
} from './draft-selection';
import { DraftKind, DraftStatus } from './schemas/draft.schema';

/**
 * Nine places in the orchestrator say "the project's draft" and mean the only one there could be.
 * Once an enhancement is a second plan, each of them has to agree on which — an ambiguous answer
 * would send the push, the board and the approval gate to three different plans.
 */

const initial = (status = DraftStatus.Approved): DraftLike => ({
  kind: DraftKind.Initial,
  seq: 0,
  status,
});

const enhancement = (seq: number, status = DraftStatus.Approved, title?: string): DraftLike => ({
  kind: DraftKind.Enhancement,
  seq,
  status,
  title,
});

describe('activeDraft', () => {
  /** Why every existing call site keeps behaving exactly as it does today. */
  it('returns the only plan a one-plan project has', () => {
    const only = initial();
    expect(activeDraft([only])).toBe(only);
  });

  it('returns nothing for a project with no plan at all', () => {
    expect(activeDraft([])).toBeNull();
  });

  it('prefers the plan still being worked on', () => {
    const open = enhancement(1, DraftStatus.BacklogDrafted);
    expect(activeDraft([initial(), open])).toBe(open);
  });

  /** A finished enhancement does not out-rank one still in flight, however new it is. */
  it('prefers an unfinished plan over a newer finished one', () => {
    const open = enhancement(1, DraftStatus.Planning);
    const later = enhancement(2, DraftStatus.Approved);
    expect(activeDraft([initial(), open, later])).toBe(open);
  });

  it('falls back to the most recent when everything is finished', () => {
    const second = enhancement(2);
    expect(activeDraft([initial(), enhancement(1), second])).toBe(second);
  });

  it('does not depend on the order they were given in', () => {
    const second = enhancement(2);
    expect(activeDraft([second, enhancement(1), initial()])).toBe(second);
  });
});

describe('isSettled', () => {
  it('counts only an approved plan as finished', () => {
    expect(isSettled(initial(DraftStatus.Approved))).toBe(true);
    for (const status of [
      DraftStatus.Intake,
      DraftStatus.Clarifying,
      DraftStatus.Planning,
      DraftStatus.Planned,
      DraftStatus.BacklogDrafting,
      DraftStatus.BacklogDrafted,
    ]) {
      expect(isSettled(initial(status))).toBe(false);
    }
  });
});

/**
 * One planning cycle at a time. Two unfinished plans would make "the project's plan" unanswerable
 * for the agents, the backlog gates and both queues.
 */
describe('unfinishedDraft', () => {
  it('finds the cycle already in flight', () => {
    const open = enhancement(1, DraftStatus.Clarifying);
    expect(unfinishedDraft([initial(), open])).toBe(open);
  });

  it('finds none when every plan is approved', () => {
    expect(unfinishedDraft([initial(), enhancement(1)])).toBeNull();
  });
});

describe('nextSeq', () => {
  it('starts a project at zero — the initial plan', () => {
    expect(nextSeq([])).toBe(0);
  });

  it('gives the first enhancement one', () => {
    expect(nextSeq([initial()])).toBe(1);
  });

  /** Never reused, so a deleted enhancement does not hand its number to the next one. */
  it('carries on past the highest, not past the count', () => {
    expect(nextSeq([initial(), enhancement(3)])).toBe(4);
  });
});

describe('enhancementRef', () => {
  it('numbers them from one, padded', () => {
    expect(enhancementRef(1)).toBe('ENH-001');
    expect(enhancementRef(2)).toBe('ENH-002');
    expect(enhancementRef(12)).toBe('ENH-012');
    expect(enhancementRef(123)).toBe('ENH-123');
  });
});

describe('draftLabel', () => {
  it('names the initial plan', () => {
    expect(draftLabel(initial())).toBe('Initial plan');
  });

  it('names an enhancement by its reference and title', () => {
    expect(draftLabel(enhancement(1, DraftStatus.Approved, 'Implement Dark Mode'))).toBe(
      'ENH-001 — Implement Dark Mode',
    );
  });

  it('falls back to the reference when it has no title', () => {
    expect(draftLabel(enhancement(1))).toBe('ENH-001');
    expect(draftLabel(enhancement(1, DraftStatus.Approved, '   '))).toBe('ENH-001');
  });
});

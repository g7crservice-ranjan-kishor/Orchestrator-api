import { stalledOutcome } from './stalled-run';
import { DraftDocument, DraftStatus } from './schemas/draft.schema';

const draft = (status: DraftStatus, currentRunId: string | null): DraftDocument =>
  ({ status, currentRunId }) as DraftDocument;

/**
 * What happens when a planning run finishes and leaves nothing behind.
 *
 * The incident: a Scrum Master run completed cleanly — Kubernetes reported the Job done, the
 * container exited zero — but posted no backlog. The draft stayed in `backlogDrafting`, so the
 * screen said "an agent is working" for twenty-five minutes while nothing was, and the only way to
 * discover it was to read the database. A run that delivers nothing is a failed run.
 */
describe('stalledOutcome', () => {
  it('returns a backlog run to where it started, with a reason', () => {
    const outcome = stalledOutcome(draft(DraftStatus.BacklogDrafting, 'run-1'), 'run-1');
    expect(outcome?.status).toBe(DraftStatus.Planned);
    expect(outcome?.message).toContain('without producing a backlog');
  });

  it('returns a planning run to intake, with a reason', () => {
    const outcome = stalledOutcome(draft(DraftStatus.Planning, 'run-1'), 'run-1');
    expect(outcome?.status).toBe(DraftStatus.Intake);
    expect(outcome?.message).toContain('without producing a plan');
  });

  /** The draft has already moved on, so the run delivered — nothing to do. */
  it('says nothing when the run delivered', () => {
    expect(stalledOutcome(draft(DraftStatus.BacklogDrafted, 'run-1'), 'run-1')).toBeNull();
    expect(stalledOutcome(draft(DraftStatus.Planned, 'run-1'), 'run-1')).toBeNull();
    expect(stalledOutcome(draft(DraftStatus.Approved, 'run-1'), 'run-1')).toBeNull();
  });

  /** A late event from a superseded run must not disturb the run now in flight. */
  it('ignores a run the draft is no longer waiting on', () => {
    expect(stalledOutcome(draft(DraftStatus.BacklogDrafting, 'run-2'), 'run-1')).toBeNull();
  });

  it('ignores a draft with no run at all', () => {
    expect(stalledOutcome(draft(DraftStatus.BacklogDrafting, null), 'run-1')).toBeNull();
  });

  it('tells the reader nothing was changed', () => {
    const outcome = stalledOutcome(draft(DraftStatus.BacklogDrafting, 'run-1'), 'run-1');
    expect(outcome?.message).toContain('Nothing was changed');
  });
});

import { canTransition, JobState } from './job-state';

/**
 * Which state changes a run is allowed to make.
 *
 * `Queued → Failed` is here because of a run that could never start: its pods died at clone every
 * time, lease-reclaim gave up on it, and the give-up was *rejected* by this table. The scheduler
 * swallowed the rejection, so the run sat Queued for ever while the board reported it as going
 * somewhere. The unit test for giving up mocked the jobs service, so it passed throughout — the
 * rule that actually refused the change was never exercised.
 */
describe('job state transitions', () => {
  it('lets a run that was abandoned before starting be failed', () => {
    expect(canTransition(JobState.Queued, JobState.Failed)).toBe(true);
  });

  it('still lets a queued run be claimed or cancelled', () => {
    expect(canTransition(JobState.Queued, JobState.Claimed)).toBe(true);
    expect(canTransition(JobState.Queued, JobState.Cancelled)).toBe(true);
  });

  /** A queued run has not started, so it cannot have finished or be running. */
  it('does not let a queued run jump straight to running or completed', () => {
    expect(canTransition(JobState.Queued, JobState.Running)).toBe(false);
    expect(canTransition(JobState.Queued, JobState.Completed)).toBe(false);
  });

  it('keeps terminal states terminal, apart from retrying a failure', () => {
    expect(canTransition(JobState.Completed, JobState.Running)).toBe(false);
    expect(canTransition(JobState.Cancelled, JobState.Queued)).toBe(false);
    expect(canTransition(JobState.Failed, JobState.Queued)).toBe(true);
  });
});

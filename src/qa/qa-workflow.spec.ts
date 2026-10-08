import {
  BUG_STATE,
  BugStatus,
  STORY_STATE,
  bugStateAfterRetest,
  canClosePreRelease,
  isBlockingBug,
  isBugOpen,
  isQaReady,
  qaItemKind,
  storyStateAfterQa,
  verdictFromOutcomes,
} from './qa-workflow';

/**
 * Unit tests for the **verified** QA state model (Task 18397) and its transition/outcome helpers
 * (Tasks 18393, 18400). Confirms the project's real Scrum names — no Resolved/Closed; a fixed Bug
 * awaiting retest and a verified Bug both live in Done — and that the work-item state is the
 * authoritative pass/fail signal derived from test-point outcomes.
 */
describe('qa-workflow', () => {
  describe('QA-ready signals', () => {
    it('classifies Stories and Bugs, and nothing else', () => {
      expect(qaItemKind('Product Backlog Item')).toBe('story');
      expect(qaItemKind('Bug')).toBe('bug');
      expect(qaItemKind('Task')).toBeNull();
      expect(qaItemKind('Feature')).toBeNull();
    });

    it('treats a Story in Done and a Bug in Done as Ready for QA (verified awaiting-retest state)', () => {
      expect(isQaReady('Product Backlog Item', 'Done')).toBe(true);
      expect(isQaReady('Bug', 'Done')).toBe(true);
      // A Bug awaiting retest is Done in this project — there is no "Resolved" state.
      expect(BUG_STATE.awaitingRetest).toBe('Done');
    });

    it('does not treat non-Done work items as Ready for QA', () => {
      expect(isQaReady('Product Backlog Item', 'Committed')).toBe(false);
      expect(isQaReady('Bug', 'Committed')).toBe(false);
      expect(isQaReady('Task', 'Done')).toBe(false);
    });
  });

  describe('verdictFromOutcomes (state precedence)', () => {
    it('passes only when every point Passed', () => {
      expect(verdictFromOutcomes(['Passed', 'Passed'])).toBe('pass');
    });

    it('fails when any point Failed (fail wins over Blocked)', () => {
      expect(verdictFromOutcomes(['Passed', 'Failed'])).toBe('fail');
      expect(verdictFromOutcomes(['Blocked', 'Failed'])).toBe('fail');
    });

    it('is blocked when a point is Blocked but none Failed', () => {
      expect(verdictFromOutcomes(['Passed', 'Blocked'])).toBe('blocked');
    });

    it('treats an empty outcome set as blocked (nothing verified), never a silent pass', () => {
      expect(verdictFromOutcomes([])).toBe('blocked');
    });
  });

  describe('storyStateAfterQa', () => {
    it('reopens the Story to Committed on fail, else keeps it Done', () => {
      expect(storyStateAfterQa('fail')).toBe(STORY_STATE.reopen);
      expect(storyStateAfterQa('fail')).toBe('Committed');
      expect(storyStateAfterQa('pass')).toBe('Done');
      expect(storyStateAfterQa('blocked')).toBe('Done');
    });
  });

  describe('bugStateAfterRetest (close path)', () => {
    it('verifies/keeps the Bug Done on pass without reassigning', () => {
      expect(bugStateAfterRetest('pass')).toEqual({ state: 'Done', reassignDeveloper: false });
    });

    it('reopens the Bug to Committed and reassigns the Developer on fail', () => {
      expect(bugStateAfterRetest('fail')).toEqual({ state: 'Committed', reassignDeveloper: true });
    });
  });

  describe('pre-release closure gate (D-010)', () => {
    const bug = (state: string, severity: string): BugStatus => ({ state, severity });

    it('treats Done/Removed as closed and everything else as open', () => {
      expect(isBugOpen(bug('Done', '1 - Critical'))).toBe(false);
      expect(isBugOpen(bug('Removed', '2 - High'))).toBe(false);
      expect(isBugOpen(bug('New', '3 - Medium'))).toBe(true);
      expect(isBugOpen(bug('Committed', '2 - High'))).toBe(true);
    });

    it('flags only open High/Critical bugs as blocking', () => {
      expect(isBlockingBug(bug('New', '1 - Critical'))).toBe(true);
      expect(isBlockingBug(bug('Committed', '2 - High'))).toBe(true);
      expect(isBlockingBug(bug('New', '3 - Medium'))).toBe(false); // low severity does not block
      expect(isBlockingBug(bug('Done', '1 - Critical'))).toBe(false); // closed does not block
    });

    it('blocks closure while an open High/Critical bug remains; low-severity may trail', () => {
      expect(canClosePreRelease([bug('New', '1 - Critical')])).toBe(false);
      expect(canClosePreRelease([bug('Committed', '2 - High')])).toBe(false);
      expect(canClosePreRelease([bug('New', '4 - Low'), bug('Done', '1 - Critical')])).toBe(true);
      expect(canClosePreRelease([])).toBe(true);
    });
  });
});

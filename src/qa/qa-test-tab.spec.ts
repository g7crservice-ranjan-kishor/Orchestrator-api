import { buildStoryTests, latestOutcomeByCase, normalizeOutcome, TestCaseRef } from './qa-test-tab';

/**
 * Unit tests for the Story Test-tab mapping (Task 18409): outcome normalisation, latest-per-case
 * reduction (with Failed winning ties so a regression is never masked), and the Case↔outcome join
 * defaulting to NotRun.
 */
describe('qa-test-tab mapping', () => {
  describe('normalizeOutcome', () => {
    it('maps known outcomes case-insensitively and everything else to NotRun', () => {
      expect(normalizeOutcome('Passed')).toBe('Passed');
      expect(normalizeOutcome('failed')).toBe('Failed');
      expect(normalizeOutcome('BLOCKED')).toBe('Blocked');
      expect(normalizeOutcome(undefined)).toBe('NotRun');
      expect(normalizeOutcome('inconclusive')).toBe('NotRun');
    });
  });

  describe('latestOutcomeByCase', () => {
    it('keeps the latest outcome per case by completedDate', () => {
      const map = latestOutcomeByCase([
        { testCaseId: 10, outcome: 'Failed', completedDate: '2026-08-01T00:00:00Z' },
        { testCaseId: 10, outcome: 'Passed', completedDate: '2026-08-02T00:00:00Z' },
      ]);
      expect(map.get(10)).toBe('Passed');
    });

    it('lets Failed win over Passed at the same timestamp (no masked regression)', () => {
      const map = latestOutcomeByCase([
        { testCaseId: 7, outcome: 'Passed', completedDate: '2026-08-02T00:00:00Z' },
        { testCaseId: 7, outcome: 'Failed', completedDate: '2026-08-02T00:00:00Z' },
      ]);
      expect(map.get(7)).toBe('Failed');
    });

    it('handles missing dates and multiple cases', () => {
      const map = latestOutcomeByCase([
        { testCaseId: 1, outcome: 'Blocked' },
        { testCaseId: 2, outcome: 'Passed' },
      ]);
      expect(map.get(1)).toBe('Blocked');
      expect(map.get(2)).toBe('Passed');
    });
  });

  describe('buildStoryTests', () => {
    const cases: TestCaseRef[] = [
      { testCaseId: 1, title: 'login works', state: 'Ready' },
      { testCaseId: 2, title: 'logout works', state: 'Ready' },
    ];

    it('joins outcomes and defaults missing ones to NotRun, preserving order', () => {
      const out = buildStoryTests(500, cases, new Map([[1, 'Passed']]));
      expect(out).toEqual({
        storyId: 500,
        testCases: [
          { testCaseId: 1, title: 'login works', state: 'Ready', outcome: 'Passed' },
          { testCaseId: 2, title: 'logout works', state: 'Ready', outcome: 'NotRun' },
        ],
      });
    });
  });
});

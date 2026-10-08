/**
 * Pure mapping for the Story **Test tab** (ARCHITECTURE.md §4B, D-021). The QA session authors Test
 * Cases (linked to the Story) and records test-point outcomes; this tab is a **read-only,
 * one-directional** projection of those Cases + their latest outcome. Kept pure so the join/latest
 * logic is unit-testable independent of the ADO REST plumbing (which is best-effort and degrades to
 * `NotRun` when the Test Results API returns nothing).
 */

/** Recorded test-point outcomes (D-020). `NotRun` covers a Case with no result yet. */
export type TestTabOutcome = 'Passed' | 'Failed' | 'Blocked' | 'NotRun';

/** A raw test result/point as read from ADO (only the fields the tab needs). */
export interface RawTestResult {
  testCaseId: number;
  outcome?: string;
  /** ISO timestamp used to pick the latest result per Case. */
  completedDate?: string;
}

/** A Test Case work item (id/title/state) as read from ADO. */
export interface TestCaseRef {
  testCaseId: number;
  title: string;
  state: string;
}

/** One row of the Test tab: the Case plus its latest recorded outcome. */
export interface StoryTestCase extends TestCaseRef {
  outcome: TestTabOutcome;
}

/** The Test tab payload for a Story. */
export interface StoryTests {
  storyId: number;
  testCases: StoryTestCase[];
}

/** Normalises a raw ADO outcome string to the tab's closed set; unknown/empty → `NotRun`. */
export function normalizeOutcome(raw: string | undefined): TestTabOutcome {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    default:
      return 'NotRun';
  }
}

/**
 * Reduces raw results to the **latest** outcome per Test Case. "Latest" is the greatest
 * `completedDate` (ISO strings compare lexicographically); when a Case has several results at the
 * same/absent time, a **Failed** result wins over a Passed/Blocked one so a regression is never
 * masked by a stale pass.
 */
export function latestOutcomeByCase(
  results: readonly RawTestResult[],
): Map<number, TestTabOutcome> {
  const latestDate = new Map<number, string>();
  const outcome = new Map<number, TestTabOutcome>();
  for (const r of results) {
    const o = normalizeOutcome(r.outcome);
    const when = r.completedDate ?? '';
    const prevWhen = latestDate.get(r.testCaseId);
    if (prevWhen === undefined || when > prevWhen) {
      latestDate.set(r.testCaseId, when);
      outcome.set(r.testCaseId, o);
    } else if (when === prevWhen && o === 'Failed') {
      outcome.set(r.testCaseId, 'Failed');
    }
  }
  return outcome;
}

/** Joins Test Cases with their latest outcome (default `NotRun`), preserving Case order. */
export function buildStoryTests(
  storyId: number,
  cases: readonly TestCaseRef[],
  outcomes: Map<number, TestTabOutcome>,
): StoryTests {
  return {
    storyId,
    testCases: cases.map((c) => ({ ...c, outcome: outcomes.get(c.testCaseId) ?? 'NotRun' })),
  };
}

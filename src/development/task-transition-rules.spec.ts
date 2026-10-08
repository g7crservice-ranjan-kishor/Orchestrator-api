import {
  ALLOWED_TRANSITIONS,
  effectiveBoardStatus,
  CLAUDE_DEVELOPER,
  TransitionContext,
  validateTaskTransition,
} from './task-transition-rules';

/**
 * The centralized transition rules — the single source of truth shared by drag-and-drop, the card
 * buttons, bulk actions and the backend API. These tests pin the business rules themselves:
 * only forward moves, Done is never user-driven, and starting development requires a current
 * sprint, an execution agent, no active run, and an approved parent Story.
 */
const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  from: 'To Do',
  to: 'In Progress',
  inAdo: true,
  kind: 'task',
  sprintTimeFrame: 'current',
  currentSprint: 'Sprint 3',
  taskSprint: 'Sprint 3',
  executionAgent: CLAUDE_DEVELOPER,
  hasActiveExecution: false,
  parentStoryApproved: true,
  hasParentStory: true,
  ...over,
});

describe('ALLOWED_TRANSITIONS', () => {
  it('only permits the forward flow Draft → To Do → In Progress', () => {
    expect(ALLOWED_TRANSITIONS.Draft).toEqual(['To Do']);
    expect(ALLOWED_TRANSITIONS['To Do']).toEqual(['In Progress']);
    // Nothing may leave In Progress or Done by user action.
    expect(ALLOWED_TRANSITIONS['In Progress']).toEqual([]);
    expect(ALLOWED_TRANSITIONS.Done).toEqual([]);
  });
});

describe('validateTaskTransition', () => {
  describe('allowed moves', () => {
    it('permits Draft → To Do for a drafted Task', () => {
      expect(validateTaskTransition(ctx({ from: 'Draft', to: 'To Do', inAdo: false })).ok).toBe(
        true,
      );
    });

    it('permits To Do → In Progress when every rule passes', () => {
      expect(validateTaskTransition(ctx()).ok).toBe(true);
    });
  });

  describe('Done is orchestrator-owned', () => {
    it.each(['Draft', 'To Do', 'In Progress'] as const)('blocks %s → Done', (from) => {
      const verdict = validateTaskTransition(ctx({ from, to: 'Done' }));
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/set by the orchestrator/i);
    });
  });

  describe('other invalid transitions', () => {
    it.each([
      ['Draft', 'In Progress'],
      ['In Progress', 'To Do'],
      ['In Progress', 'Draft'],
      ['Done', 'To Do'],
      ['Done', 'In Progress'],
    ] as const)('blocks %s → %s', (from, to) => {
      const verdict = validateTaskTransition(ctx({ from, to }));
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/not a supported transition/i);
    });

    it('blocks a no-op move onto the same column', () => {
      expect(validateTaskTransition(ctx({ from: 'To Do', to: 'To Do' })).ok).toBe(false);
    });

    it('blocks a work item that is neither a Task nor a Bug', () => {
      const verdict = validateTaskTransition(ctx({ kind: 'other' }));
      expect(verdict.reason).toMatch(/Tasks and Bugs/i);
    });

    /**
     * A Developer agent also fixes QA-found defects (D-019). A Bug is raised against work already
     * under way, so the parent-Story approval gate — a Task concept — does not apply to it.
     */
    it('allows a Bug to start development without a parent Story', () => {
      const verdict = validateTaskTransition(
        ctx({ kind: 'bug', hasParentStory: false, parentStoryApproved: null }),
      );
      expect(verdict.ok).toBe(true);
    });

    it('still blocks a Bug that already has a run in flight', () => {
      const verdict = validateTaskTransition(ctx({ kind: 'bug', hasActiveExecution: true }));
      expect(verdict.ok).toBe(false);
    });

    it('still blocks a Bug in a future sprint', () => {
      const verdict = validateTaskTransition(ctx({ kind: 'bug', sprintTimeFrame: 'future' }));
      expect(verdict.ok).toBe(false);
    });
  });

  describe('Draft → To Do', () => {
    it('blocks a Task that is already in Azure DevOps', () => {
      const verdict = validateTaskTransition(ctx({ from: 'Draft', to: 'To Do', inAdo: true }));
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/already in azure devops/i);
    });
  });

  describe('To Do → In Progress', () => {
    it('blocks a Task that is not in Azure DevOps yet', () => {
      const verdict = validateTaskTransition(ctx({ inAdo: false }));
      expect(verdict.reason).toMatch(/not in azure devops/i);
      expect(verdict.hint).toMatch(/approve it/i);
    });

    it('blocks a future-sprint Task and names both sprints', () => {
      const verdict = validateTaskTransition(
        ctx({ sprintTimeFrame: 'future', taskSprint: 'Sprint 4', currentSprint: 'Sprint 3' }),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('Sprint 4');
      expect(verdict.reason).toContain('Sprint 3');
      expect(verdict.hint).toMatch(/wait until/i);
    });

    it('allows a current-sprint Task and a past-sprint Task', () => {
      expect(validateTaskTransition(ctx({ sprintTimeFrame: 'current' })).ok).toBe(true);
      expect(validateTaskTransition(ctx({ sprintTimeFrame: 'past' })).ok).toBe(true);
    });

    it('does not block when the sprint cannot be classified', () => {
      expect(validateTaskTransition(ctx({ sprintTimeFrame: 'unknown' })).ok).toBe(true);
    });

    it('blocks when no execution agent is assigned', () => {
      const verdict = validateTaskTransition(ctx({ executionAgent: null }));
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/no execution agent/i);
    });

    it('blocks a Task that already has an active execution', () => {
      const verdict = validateTaskTransition(ctx({ hasActiveExecution: true }));
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/already has an active/i);
    });

    it('blocks when the parent Story is not approved', () => {
      const verdict = validateTaskTransition(ctx({ parentStoryApproved: false }));
      expect(verdict.reason).toMatch(/parent story is not approved/i);
    });

    it('blocks when the Task has no parent Story', () => {
      const verdict = validateTaskTransition(ctx({ hasParentStory: false }));
      expect(verdict.reason).toMatch(/no parent story/i);
    });

    it('does not block when the parent Story state is unknown', () => {
      expect(validateTaskTransition(ctx({ parentStoryApproved: null })).ok).toBe(true);
    });

    it('reports an active execution before the sprint rule (the more actionable reason wins)', () => {
      const verdict = validateTaskTransition(
        ctx({ hasActiveExecution: true, sprintTimeFrame: 'future' }),
      );
      expect(verdict.reason).toMatch(/already has an active/i);
    });
  });
});

/**
 * Where a work item really stands, once the live run is taken into account.
 *
 * Bug #628 spent ten hours in the In Progress column with no action available. A Developer run had
 * finished at 01:16; a QA agent rejected the fix at 10:57 and reopened the Bug to `Committed`,
 * which for a Bug means "a Developer agent is on it". Nobody was. Three separate places asked this
 * question — the board column, the Fix button, and the transition that dispatches — and each was
 * fixed in turn while the next one kept refusing, so the rule now lives in one function.
 */
describe('effectiveBoardStatus', () => {
  it('moves a reopened Bug back to To Do when nothing is running', () => {
    expect(effectiveBoardStatus('bug', 'In Progress', false)).toBe('To Do');
  });

  it('leaves a Bug in In Progress while its run is live', () => {
    expect(effectiveBoardStatus('bug', 'In Progress', true)).toBe('In Progress');
  });

  it('never touches a Task — Committed means something else there', () => {
    expect(effectiveBoardStatus('task', 'In Progress', false)).toBe('In Progress');
  });

  it('leaves every other status alone', () => {
    expect(effectiveBoardStatus('bug', 'To Do', false)).toBe('To Do');
    expect(effectiveBoardStatus('bug', 'Done', false)).toBe('Done');
    expect(effectiveBoardStatus('bug', 'Draft', false)).toBe('Draft');
  });
});

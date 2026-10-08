import { describeStates, pickReadyState, WorkItemState } from './work-item-states';

/**
 * Choosing the state a pushed Story is created in.
 *
 * It used to be the literal string `Approved`, which is Scrum's name for it. A push into a project
 * whose backlog item had no such state failed on the very first Story with "The field 'State'
 * contains the value 'Approved' that is not in the list of supported values" — and nothing in that
 * message says what the states actually are, so there was no next step.
 */
const state = (name: string, category: string): WorkItemState => ({ name, category });

/** Azure DevOps' own Scrum workflow for a Product Backlog Item. */
const SCRUM = [
  state('New', 'Proposed'),
  state('Approved', 'Proposed'),
  state('Committed', 'InProgress'),
  state('Done', 'Completed'),
  state('Removed', 'Removed'),
];

/** Agile's User Story, which has no second proposed state at all. */
const AGILE = [
  state('New', 'Proposed'),
  state('Active', 'InProgress'),
  state('Resolved', 'Resolved'),
  state('Closed', 'Completed'),
];

describe('ready state', () => {
  /** Every project that works today must keep behaving identically. */
  it('uses Approved when the process has it', () => {
    expect(pickReadyState(SCRUM)).toBe('Approved');
  });

  it('matches the name whatever its casing', () => {
    expect(pickReadyState([state('New', 'Proposed'), state('APPROVED', 'Proposed')])).toBe(
      'APPROVED',
    );
  });

  /**
   * One proposed state means there is nowhere to move to that still means "not started" — so the
   * Story is left alone rather than pushed into Active, which would claim work had begun.
   */
  it('leaves the Story alone when the process has only one proposed state', () => {
    expect(pickReadyState(AGILE)).toBeNull();
  });

  /** An inherited process can name it anything; the shape is what identifies it. */
  it('takes the second proposed state when it has another name', () => {
    const custom = [
      state('New', 'Proposed'),
      state('Ready for Dev', 'Proposed'),
      state('Doing', 'InProgress'),
    ];
    expect(pickReadyState(custom)).toBe('Ready for Dev');
  });

  it('takes the last proposed state when there are several', () => {
    const custom = [
      state('New', 'Proposed'),
      state('Triaged', 'Proposed'),
      state('Ready', 'Proposed'),
    ];
    expect(pickReadyState(custom)).toBe('Ready');
  });

  /** A type whose states could not be read must not produce a guess. */
  it('returns nothing for an empty or unusable list', () => {
    expect(pickReadyState([])).toBeNull();
    expect(pickReadyState([state('  ', 'Proposed')])).toBeNull();
  });

  /** Never a started or finished state: the push has not done any work yet. */
  it('never picks a state that claims work has started or finished', () => {
    const picked = pickReadyState([
      state('New', 'Proposed'),
      state('Doing', 'InProgress'),
      state('Done', 'Completed'),
    ]);
    expect(picked).toBeNull();
  });
});

describe('describing states', () => {
  it('lists the names so a message can say what is actually available', () => {
    expect(describeStates(AGILE)).toBe('New, Active, Resolved, Closed');
  });

  it('says so plainly when there are none', () => {
    expect(describeStates([])).toBe('none reported');
  });
});

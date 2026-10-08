import {
  blockedReason,
  isSettled,
  isWaitingReason,
  unsettled,
  WAITING_MARKER,
} from './blocking-dependencies';

/**
 * A new Task must wait for the old Task it needs.
 *
 * "Add a dark mode toggle to the Settings page" depends on **Build the Settings page**, which may
 * still be in To Do. Dispatched anyway, the agent finds no Settings page and either fails or builds
 * its own — and later the original Task builds a second one.
 */

const dep = (id: number, state: string, title = `Work item ${id}`) => ({ id, title, state });

describe('isSettled', () => {
  it('counts the states in which nothing is still owed', () => {
    expect(isSettled('Done')).toBe(true);
    expect(isSettled('Closed')).toBe(true);
    expect(isSettled('done')).toBe(true);
    expect(isSettled(' Done ')).toBe(true);
  });

  /** Cancelled work will never reach Done; blocking on it would strand everything behind it. */
  it('counts removed work as settled', () => {
    expect(isSettled('Removed')).toBe(true);
  });

  it('counts work still to come as unsettled', () => {
    expect(isSettled('To Do')).toBe(false);
    expect(isSettled('In Progress')).toBe(false);
    expect(isSettled('New')).toBe(false);
    expect(isSettled('Committed')).toBe(false);
    expect(isSettled('')).toBe(false);
  });
});

describe('unsettled', () => {
  it('keeps only what is still owed, in order', () => {
    const waiting = unsettled([dep(1, 'Done'), dep(2, 'To Do'), dep(3, 'In Progress')]);
    expect(waiting.map((d) => d.id)).toEqual([2, 3]);
  });

  it('is empty when everything is finished', () => {
    expect(unsettled([dep(1, 'Done'), dep(2, 'Removed')])).toEqual([]);
  });
});

describe('blockedReason', () => {
  it('says nothing when nothing is holding the Task up', () => {
    expect(blockedReason('812', [dep(790, 'Done')])).toBeNull();
    expect(blockedReason('812', [])).toBeNull();
  });

  /** A reason has to name the blocker — "1 dependency unmet" is not something anyone can act on. */
  it('names the work item it is waiting for, and its state', () => {
    const reason = blockedReason('812', [dep(790, 'To Do', 'Build the Settings page')]);
    expect(reason).toContain('#790');
    expect(reason).toContain('Build the Settings page');
    expect(reason).toContain('To Do');
  });

  it('says it will start on its own, so nobody goes looking for a button', () => {
    expect(blockedReason('812', [dep(790, 'To Do')])).toMatch(/start on its own/i);
  });

  it('ignores the dependencies that are already finished', () => {
    const reason = blockedReason('812', [dep(1, 'Done'), dep(790, 'To Do', 'Settings page')]);
    expect(reason).toContain('#790');
    expect(reason).not.toContain('#1 ');
  });

  /** A reason nobody reads to the end is a reason nobody uses. */
  it('summarises once there are more than two', () => {
    const reason = blockedReason('812', [
      dep(1, 'To Do'),
      dep(2, 'To Do'),
      dep(3, 'To Do'),
      dep(4, 'To Do'),
    ]);
    expect(reason).toContain('#1');
    expect(reason).toContain('#2');
    expect(reason).toContain('and 2 more');
    expect(reason).not.toContain('#4');
  });
});

/**
 * The queue reads the reason to decide whether to come back to a Task.
 *
 * Two different things must not be confused: "not yet" leaves the Task queued, and it starts on its
 * own once the blocker is Done; "not ever" marks it terminal so the queue stops reconsidering it.
 * One constant is written by `blockedReason` and read by `isWaitingReason`, and this is what pins
 * that they still agree — a mock of either would prove nothing.
 */
describe('telling "not yet" apart from "not ever"', () => {
  it('marks a dependency refusal as waiting', () => {
    const reason = blockedReason('812', [dep(790, 'To Do')]);
    expect(reason).toContain(WAITING_MARKER);
    expect(isWaitingReason(reason)).toBe(true);
  });

  it('does not mark an ordinary refusal as waiting', () => {
    expect(isWaitingReason("Task 812 is 'Done', not 'To Do'")).toBe(false);
    expect(isWaitingReason(null)).toBe(false);
    expect(isWaitingReason(undefined)).toBe(false);
  });
});

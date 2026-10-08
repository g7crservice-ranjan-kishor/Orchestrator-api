import { AdoIteration } from './ado-client.service';
import {
  anchorIndex,
  describeSprintPlan,
  newSprintNames,
  planSprints,
  sprintNumberOf,
} from './sprint-anchor';

/**
 * An enhancement's work must not be created inside a sprint that is already over.
 *
 * A Scrum Master always numbers from one, because it is planning a body of work rather than reading
 * a calendar. On the Employee Management System Sprint 1 closed on 30 September, so ENH-001's Tasks
 * would have been created in a closed sprint — in Azure DevOps, absent from the board, picked up by
 * nothing. The agent decides order; the orchestrator decides when.
 */

const sprint = (name: string, timeFrame: string): AdoIteration => ({
  name,
  path: `Proj\\${name}`,
  timeFrame,
  startDate: null,
  finishDate: null,
});

/** The project's real state: three closed sprints, one running, two empty ahead. */
const EMS: AdoIteration[] = [
  sprint('Sprint 1', 'past'),
  sprint('Sprint 2', 'past'),
  sprint('Sprint 3', 'past'),
  sprint('Sprint 4', 'current'),
  sprint('Sprint 5', 'future'),
  sprint('Sprint 6', 'future'),
];

describe('sprintNumberOf', () => {
  it('reads the number out of a sprint name', () => {
    expect(sprintNumberOf('Sprint 3')).toBe(3);
    expect(sprintNumberOf('Sprint 12')).toBe(12);
  });

  it('says nothing for a name with no number in it', () => {
    expect(sprintNumberOf('Hardening')).toBeNull();
    expect(sprintNumberOf(null)).toBeNull();
  });
});

describe('anchorIndex', () => {
  it('starts at the sprint running now', () => {
    expect(anchorIndex(EMS, 'current')).toBe(3); // Sprint 4
  });

  it('starts at the one after, on request', () => {
    expect(anchorIndex(EMS, 'next')).toBe(4); // Sprint 5
  });

  /** A project between sprints still has to be able to schedule. */
  it('falls back to the first future sprint when none is current', () => {
    const between = [sprint('Sprint 1', 'past'), sprint('Sprint 2', 'future')];
    expect(anchorIndex(between, 'current')).toBe(1);
    expect(anchorIndex(between, 'next')).toBe(1);
  });

  it('falls back to the first sprint when nothing is dated', () => {
    const undated = [sprint('Sprint 1', 'unknown'), sprint('Sprint 2', 'unknown')];
    expect(anchorIndex(undated, 'current')).toBe(0);
  });

  it('has nowhere to start when the project has no sprints', () => {
    expect(anchorIndex([], 'current')).toBe(-1);
  });
});

describe('planSprints', () => {
  /** The whole point. */
  it('lands the first relative sprint on the one running now', () => {
    const plan = planSprints(['Sprint 1', 'Sprint 2', 'Sprint 3'], EMS);
    expect(plan.mapping.get('Sprint 1')).toBe('Sprint 4');
    expect(plan.mapping.get('Sprint 2')).toBe('Sprint 5');
    expect(plan.mapping.get('Sprint 3')).toBe('Sprint 6');
    expect(plan.missing).toEqual([]);
    expect(plan.anchorName).toBe('Sprint 4');
  });

  it('starts from the next sprint on request', () => {
    const plan = planSprints(['Sprint 1', 'Sprint 2'], EMS, 'next');
    expect(plan.mapping.get('Sprint 1')).toBe('Sprint 5');
    expect(plan.mapping.get('Sprint 2')).toBe('Sprint 6');
  });

  /** "Sprint 1 then Sprint 3" means "and then", not "leave a gap". */
  it('treats relative numbering as order, not arithmetic', () => {
    const plan = planSprints(['Sprint 1', 'Sprint 3'], EMS);
    expect(plan.mapping.get('Sprint 1')).toBe('Sprint 4');
    expect(plan.mapping.get('Sprint 3')).toBe('Sprint 5');
  });

  it('does not care what order the backlog mentioned them in', () => {
    const plan = planSprints(['Sprint 2', 'Sprint 1', 'Sprint 2'], EMS);
    expect(plan.mapping.get('Sprint 1')).toBe('Sprint 4');
    expect(plan.mapping.get('Sprint 2')).toBe('Sprint 5');
  });

  it('reports the sprints the project does not have yet', () => {
    const plan = planSprints(['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4'], EMS);
    expect(plan.mapping.size).toBe(3);
    expect(plan.missing).toEqual(['Sprint 4']);
  });

  /** A project naming its sprints some other way is left alone rather than guessed at. */
  it('ignores a sprint name with no number in it', () => {
    const plan = planSprints(['Hardening', 'Sprint 1'], EMS);
    expect(plan.mapping.has('Hardening')).toBe(false);
    expect(plan.mapping.get('Sprint 1')).toBe('Sprint 4');
  });

  it('maps nothing for a project with no sprints at all', () => {
    const plan = planSprints(['Sprint 1'], []);
    expect(plan.mapping.size).toBe(0);
    expect(plan.missing).toEqual(['Sprint 1']);
    expect(plan.anchorName).toBeNull();
  });

  /** An initial build anchored at Sprint 1 keeps the names it was given. */
  it('changes nothing when the anchor is already the first sprint', () => {
    const fresh = [sprint('Sprint 1', 'current'), sprint('Sprint 2', 'future')];
    const plan = planSprints(['Sprint 1', 'Sprint 2'], fresh);
    expect(plan.mapping.get('Sprint 1')).toBe('Sprint 1');
    expect(plan.mapping.get('Sprint 2')).toBe('Sprint 2');
  });
});

describe('newSprintNames', () => {
  it('carries on the project’s own numbering', () => {
    expect(newSprintNames(EMS, 2)).toEqual(['Sprint 7', 'Sprint 8']);
  });

  it('asks for none when none are needed', () => {
    expect(newSprintNames(EMS, 0)).toEqual([]);
  });

  it('counts from the length when the sprints are not numbered', () => {
    const odd = [sprint('Hardening', 'past'), sprint('Discovery', 'current')];
    expect(newSprintNames(odd, 1)).toEqual(['Sprint 3']);
  });
});

describe('describeSprintPlan', () => {
  it('says what moved where', () => {
    const text = describeSprintPlan(planSprints(['Sprint 1', 'Sprint 2'], EMS));
    expect(text).toContain('Sprint 1 → Sprint 4');
    expect(text).toContain('Sprint 2 → Sprint 5');
  });

  it('says so when nothing needed moving', () => {
    const fresh = [sprint('Sprint 1', 'current')];
    expect(describeSprintPlan(planSprints(['Sprint 1'], fresh))).toMatch(/already matched/i);
  });

  it('says so when there was nothing to schedule', () => {
    expect(describeSprintPlan(planSprints([], EMS))).toMatch(/no sprints were rescheduled/i);
  });
});

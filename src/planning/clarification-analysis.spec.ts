import {
  confirmedDecisions,
  groupByCategory,
  normaliseCategory,
  questionKey,
  selectClarifications,
  unanswered,
} from './clarification-analysis';

/**
 * Which questions reach a person.
 *
 * Two failures sit either side of this, and the first one is measured: across every project ever
 * planned here, the number of clarifying questions asked is **zero** — including `student
 * management for college`, four words that became six epics with nothing asked. The second is the
 * one that makes people stop reading: a question whose answer is already written down.
 */

describe('reading the category an agent wrote', () => {
  it('takes the canonical names', () => {
    expect(normaliseCategory('functional')).toBe('functional');
    expect(normaliseCategory('edge-cases')).toBe('edge-cases');
  });

  it('takes the words people actually write', () => {
    expect(normaliseCategory('UI/UX')).toBe('ux');
    expect(normaliseCategory('Business Rules')).toBe('business-rules');
    expect(normaliseCategory('permissions')).toBe('roles');
    expect(normaliseCategory('data model')).toBe('data');
    expect(normaliseCategory('Notifications')).toBe('integrations');
    expect(normaliseCategory('performance')).toBe('technical');
  });

  /**
   * A question whose label could not be parsed is still a question worth asking. Dropping it for a
   * vocabulary mismatch would be the tooling discarding the thing it exists to surface.
   */
  it('keeps a question whose category it does not recognise', () => {
    expect(normaliseCategory('wibble')).toBe('functional');
    expect(normaliseCategory('')).toBe('functional');
    expect(normaliseCategory(null)).toBe('functional');
  });
});

describe('recognising the same question twice', () => {
  it('ignores case, punctuation and plurals', () => {
    expect(questionKey('Can users edit expenses?')).toBe(questionKey('can a user edit an expense'));
  });

  it('does not collapse two different questions', () => {
    expect(questionKey('Can users edit expenses?')).not.toBe(
      questionKey('Can users delete expenses?'),
    );
  });
});

describe('deciding what to ask', () => {
  const q = (question: string, category = 'functional') => ({ question, category });

  it('asks what nobody has answered', () => {
    const { ask } = selectClarifications([q('Can users delete an expense?')]);
    expect(ask).toHaveLength(1);
  });

  /**
   * The "previously confirmed decisions" step. An answer is a fact; asking again invites a second,
   * contradicting answer and leaves nothing to say which one the plan was built on.
   */
  it('never re-asks something already answered', () => {
    const { ask, skipped } = selectClarifications(
      [q('Can users edit expenses?')],
      [{ question: 'Can a user edit an expense?', answer: 'Yes, within 30 days.' }],
    );
    expect(ask).toEqual([]);
    expect(skipped[0].reason).toBe('already-answered');
  });

  /** A regeneration re-runs the agent; the same question must not stack up twice on the page. */
  it('does not ask a question that is already outstanding', () => {
    const { ask, skipped } = selectClarifications(
      [q('Which categories are available?')],
      [{ question: 'Which categories are available?', answer: null }],
    );
    expect(ask).toEqual([]);
    expect(skipped[0].reason).toBe('already-asked');
  });

  it('drops a question the agent asked twice in one batch', () => {
    const { ask, skipped } = selectClarifications([
      q('Can users delete an expense?'),
      q('Can a user delete an expense'),
    ]);
    expect(ask).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate');
  });

  it('drops an empty question', () => {
    const { ask, skipped } = selectClarifications([q('   ')]);
    expect(ask).toEqual([]);
    expect(skipped[0].reason).toBe('empty');
  });

  /**
   * Importance is the agent's judgement, made with the requirement in front of it. A rule here
   * guessing from the words alone would suppress exactly the unusual question most worth asking.
   */
  it('does not try to judge importance itself', () => {
    const odd = q('Should an expense dated in the future be allowed?', 'edge-cases');
    expect(selectClarifications([odd]).ask).toEqual([expect.objectContaining(odd)]);
  });

  it('keeps what the agent said about each question', () => {
    const { ask } = selectClarifications([
      {
        question: 'Can users delete an expense?',
        category: 'functional',
        why: 'Decides whether the API needs a delete endpoint.',
        assumption: 'Assume yes, with a confirmation step.',
      },
    ]);
    expect(ask[0]).toMatchObject({
      why: 'Decides whether the API needs a delete endpoint.',
      assumption: 'Assume yes, with a confirmation step.',
    });
  });

  it('copes with nothing at all', () => {
    expect(selectClarifications([]).ask).toEqual([]);
    expect(selectClarifications([], []).skipped).toEqual([]);
  });
});

describe('what is still outstanding', () => {
  const items = [
    { question: 'A?', answer: 'yes' },
    { question: 'B?', answer: null },
    { question: 'C?', answer: '   ' },
  ];

  it('counts a blank answer as unanswered', () => {
    expect(unanswered(items).map((i) => i.question)).toEqual(['B?', 'C?']);
  });

  it('reports the confirmed decisions, and only those', () => {
    expect(confirmedDecisions(items)).toEqual([{ question: 'A?', answer: 'yes' }]);
  });
});

describe('grouping for the page', () => {
  it('groups in a fixed order and leaves out the empty categories', () => {
    const groups = groupByCategory([
      { question: 'a', category: 'edge-cases' },
      { question: 'b', category: 'functional' },
      { question: 'c', category: 'ui' },
    ]);
    expect(groups.map((g) => g.category)).toEqual(['functional', 'ux', 'edge-cases']);
    expect(groups[0].label).toBe('What it does');
  });

  it('has nothing to group when there are no questions', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

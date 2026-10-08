import { mitigationOf, planFeedbackFor, stripPlanPreamble, validatePlan } from './plan-validation';

const REPOS = [
  'https://dev.azure.com/org/Proj/_git/taskmanager-api',
  'https://dev.azure.com/org/Proj/_git/taskmanager-ui',
];
const EXPECTED = { uiStyleLabel: 'Ant Design', targetRepos: REPOS };

/** A plan that satisfies everything the project binds it to. */
const GOOD = `# Plan

## Objective

Deliver a task manager across taskmanager-api and taskmanager-ui.

## User interface

**UI approach.** The technology constraints name Ant Design as the chosen UI approach.

## Breakdown

**Epic 6: Frontend UI foundation**
- Story: Design system — a single Ant Design ConfigProvider theme-tokens file
- Story: Application shell — header, navigation, signed-in user, sign-out
- Story: Loading / empty / error states for every data view
`;

/**
 * The plan the Engineering Manager actually produced on a fresh run with EM v4 — every constraint
 * delivered, every rule in the template, and none of it reflected. It even chose its own frontend
 * stack. Compliance came only when a human typed the gaps into the feedback box, five runs
 * running; this is that feedback, generated.
 */
const REAL_FAILURE = `# Plan

## Objective

Deliver a working Task Manager application, split across two independently versioned
repositories (frontend, backend).

## Scope

**Technology approach**
- Backend: Node.js + TypeScript, Express, Prisma ORM with the SQL Server connector.
- Frontend: React + TypeScript via Vite, React Router for login/register/dashboard routes.

## Breakdown

**Epic 5: Frontend UX**
- Auth pages: login/register forms with client-side validation feedback.
- Task dashboard: list, create form, complete-toggle, delete, empty state.
`;

describe('validatePlan', () => {
  const messages = (plan: string, expected = EXPECTED) =>
    validatePlan(plan, expected).map((i) => i.message);

  it('passes a plan that names the approach, the foundation and the repositories', () => {
    expect(validatePlan(GOOD, EXPECTED)).toEqual([]);
  });

  describe('the plan that got through', () => {
    it('catches every one of its gaps', () => {
      expect(messages(REAL_FAILURE)).toEqual([
        'The plan has no "## User interface" section.',
        'The plan never names the chosen UI approach (Ant Design).',
        'The plan does not cover a design system, an application shell, loading, empty and error states.',
        'The plan never names taskmanager-api or taskmanager-ui.',
      ]);
    });

    /** Whatever else is true, a plan this incomplete must not be silently accepted. */
    it('reports them as errors, not advice', () => {
      expect(validatePlan(REAL_FAILURE, EXPECTED).every((i) => i.severity === 'error')).toBe(true);
    });
  });

  it('flags a missing User interface section', () => {
    const plan = GOOD.replace('## User interface', '## Interface notes');
    expect(messages(plan)).toContain('The plan has no "## User interface" section.');
  });

  it('flags a plan that substitutes a different styling approach', () => {
    const plan = GOOD.replace(/Ant Design/g, 'Tailwind CSS');
    expect(messages(plan)).toContain('The plan never names the chosen UI approach (Ant Design).');
  });

  it('flags a plan that never names a repository', () => {
    const plan = GOOD.replace('taskmanager-ui', 'the frontend repo');
    expect(messages(plan)).toContain('The plan never names taskmanager-ui.');
  });

  it('flags a missing application shell even when the design system is there', () => {
    const plan = GOOD.replace(/- Story: Application shell.*\n/, '');
    expect(messages(plan)).toContain('The plan does not cover an application shell.');
  });

  /** A project that imposes no UI approach gets no UI expectations imposed on its plan. */
  it('says nothing about the interface when the project leaves it open', () => {
    expect(validatePlan(REAL_FAILURE, { targetRepos: [] })).toEqual([]);
    expect(validatePlan(REAL_FAILURE, { uiStyleLabel: null, targetRepos: [] })).toEqual([]);
  });

  it('says nothing about repositories when the project lists none', () => {
    expect(messages(GOOD, { uiStyleLabel: 'Ant Design', targetRepos: [] })).toEqual([]);
  });
});

describe('planFeedbackFor', () => {
  it('turns the gaps into the instructions a human would otherwise type', () => {
    const feedback = planFeedbackFor(validatePlan(REAL_FAILURE, EXPECTED));
    expect(feedback).toContain('Add the mandatory `## User interface` section');
    expect(feedback).toContain('**Ant Design**');
    expect(feedback).toContain('taskmanager-api and taskmanager-ui');
    expect(feedback).toContain('UI foundation Epic');
  });

  /** Regeneration must not cost the parts of the plan that were already good. */
  it('tells the agent to keep what already works', () => {
    const feedback = planFeedbackFor(validatePlan(REAL_FAILURE, EXPECTED));
    expect(feedback).toContain('Keep the existing scope, phases, risks and credentials');
  });
});

describe('stripPlanPreamble', () => {
  /** Exactly what a regeneration produced: commentary, under a heading the pipeline parses. */
  it('drops a "## Clarifications — none" preamble a regeneration added', () => {
    const raw = [
      '## Clarifications',
      '',
      'None — the feedback is unambiguous. Below is the revised plan.',
      '',
      '# Plan',
      '',
      '## Objective',
      '',
      'Deliver it.',
    ].join(String.fromCharCode(10));
    const stripped = stripPlanPreamble(raw);
    expect(stripped.startsWith('# Plan')).toBe(true);
    expect(stripped).not.toContain('Clarifications');
    expect(stripped).toContain('## Objective');
  });

  it('leaves a plan that already starts correctly untouched', () => {
    const plan = '# Plan' + String.fromCharCode(10, 10) + '## Objective';
    expect(stripPlanPreamble(plan)).toBe(plan);
  });

  /** Never lose content: with nothing to anchor on, keep everything. */
  it('keeps the whole text when there is no "# Plan" heading', () => {
    const odd = '## Clarifications' + String.fromCharCode(10, 10) + '- Which database?';
    expect(stripPlanPreamble(odd)).toBe(odd);
  });

  it('does not mistake a "# Planning notes" heading for the plan', () => {
    const raw = '# Planning notes' + String.fromCharCode(10, 10) + 'blah';
    expect(stripPlanPreamble(raw)).toBe(raw);
  });

  it('tolerates empty input', () => {
    expect(stripPlanPreamble('')).toBe('');
  });
});

/**
 * A risk must name the work that addresses it.
 *
 * The incident: the approved plan said, in as many words, "CORS/config mismatch between separately
 * hosted taskmanager-ui and taskmanager-api — mitigate by defining CORS and base-URL configuration
 * explicitly and documenting it in both READMEs." No Story was ever drafted for it. The API shipped
 * with no CORS handling, and the interface could not call it from a browser at all. Naming a risk
 * and addressing it are different things; `mitigated by:` makes the difference checkable.
 */
describe('risks must name work', () => {
  const plan = (risks: string[], breakdown = '') =>
    ['# Plan', '', '## Risks', '', ...risks, '', '## Breakdown', '', breakdown].join(
      String.fromCharCode(10),
    );

  const riskIssues = (markdown: string) =>
    validatePlan(markdown).filter((i) => /risk/i.test(i.message));

  it('rejects a risk that names no mitigating work', () => {
    const issues = riskIssues(plan(['- CORS mismatch between the two apps.']));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].instruction).toContain('mitigated by:');
  });

  it('accepts a risk whose named work is in the Breakdown', () => {
    const markdown = plan(
      ['- CORS mismatch between the two apps — mitigated by: Cross-origin configuration'],
      '- Feature: Cross-origin configuration — allow the UI origin explicitly.',
    );
    expect(riskIssues(markdown)).toEqual([]);
  });

  it('rejects a mitigation that names work the Breakdown does not contain', () => {
    const markdown = plan(
      ['- CORS mismatch — mitigated by: Cross-origin configuration'],
      '- Feature: Something else entirely.',
    );
    const issues = riskIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/not in the Breakdown/i);
  });

  it('counts how many risks are unaddressed', () => {
    const issues = riskIssues(
      plan(
        ['- Risk one — mitigated by: Work A', '- Risk two.', '- Risk three.'],
        '- Feature: Work A',
      ),
    );
    expect(issues[0].message).toContain('2 of 3');
  });

  it('asks nothing of a plan with no Risks section', () => {
    expect(
      riskIssues('# Plan' + String.fromCharCode(10) + String.fromCharCode(10) + '## Scope'),
    ).toEqual([]);
  });
});

/**
 * The name of the work a risk points at.
 *
 * A real plan wrote "mitigated by: Settings drawer for durations and long-break interval (documents
 * the next-session-applies rule in its acceptance criteria)." — the aside explains the mitigation,
 * it is not part of the Feature's name. Keeping it meant the name never matched the Feature that
 * was actually drafted, and a complete backlog was reported as leaving a risk unaddressed.
 */
describe('mitigation names', () => {
  const of = (text: string) => mitigationOf(`- Some risk — mitigated by: ${text}`);

  it('reads a plain name', () => {
    expect(of('Timestamp-based countdown engine')).toBe('Timestamp-based countdown engine');
  });

  it('drops a trailing aside', () => {
    expect(of('Settings drawer (documents the rule)')).toBe('Settings drawer');
  });

  /** The aside is followed by a full stop, so it is not last until the stop is removed. */
  it('drops a trailing aside that is followed by a full stop', () => {
    expect(of('Settings drawer (documents the rule).')).toBe('Settings drawer');
  });

  /** Brackets in the middle belong to the name. */
  it('keeps brackets that are not at the end', () => {
    expect(of('Local storage (safe) fallbacks')).toBe('Local storage (safe) fallbacks');
  });

  it('is null when nothing is named', () => {
    expect(mitigationOf('- A risk with no mitigation')).toBeNull();
  });
});

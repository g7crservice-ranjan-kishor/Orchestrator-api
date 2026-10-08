import { validateBacklog, ValidationContext } from './backlog-validation';
import { BacklogItem, BacklogItemType } from './schemas/draft.schema';

function item(over: Partial<BacklogItem> & Pick<BacklogItem, 'id' | 'type'>): BacklogItem {
  return {
    title: 'T',
    description: '',
    acceptanceCriteria: '',
    parentId: null,
    order: 0,
    priority: 2,
    estimate: null,
    dependsOn: [],
    repo: null,
    sprint: null,
    attachments: [],
    ...over,
  } as BacklogItem;
}

describe('validateBacklog', () => {
  it('passes a well-formed Epic→Feature→Story→Task tree', () => {
    const items = [
      item({ id: 'e', type: BacklogItemType.Epic, title: 'Epic' }),
      item({ id: 'f', type: BacklogItemType.Feature, parentId: 'e', title: 'Feature' }),
      item({
        id: 's',
        type: BacklogItemType.Story,
        parentId: 'f',
        title: 'Story',
        acceptanceCriteria: 'Given/When/Then',
      }),
      item({ id: 't', type: BacklogItemType.Task, parentId: 's', title: 'Task' }),
    ];
    expect(validateBacklog(items)).toHaveLength(0);
  });

  it('flags a missing title', () => {
    const issues = validateBacklog([item({ id: 'e', type: BacklogItemType.Epic, title: '  ' })]);
    expect(issues.some((i) => i.message === 'Title is required.')).toBe(true);
  });

  it('flags an invalid parent type (task under epic)', () => {
    const items = [
      item({ id: 'e', type: BacklogItemType.Epic }),
      item({ id: 't', type: BacklogItemType.Task, parentId: 'e' }),
    ];
    expect(validateBacklog(items).some((i) => i.message.includes('cannot be a child of'))).toBe(
      true,
    );
  });

  it('flags a non-existent parent', () => {
    const items = [item({ id: 'f', type: BacklogItemType.Feature, parentId: 'ghost' })];
    expect(validateBacklog(items).some((i) => i.message.includes('does not exist'))).toBe(true);
  });

  it('flags a non-existent dependency', () => {
    const items = [item({ id: 'e', type: BacklogItemType.Epic, dependsOn: ['ghost'] })];
    expect(validateBacklog(items).some((i) => i.message.includes('Dependency ghost'))).toBe(true);
  });

  it('flags duplicate items sharing a title (case/space-insensitive)', () => {
    const items = [
      item({ id: 'a', type: BacklogItemType.Task, title: 'Write tests' }),
      item({ id: 'b', type: BacklogItemType.Task, title: '  write   TESTS ' }),
      item({ id: 'c', type: BacklogItemType.Task, title: 'Unique' }),
    ];
    const dupes = validateBacklog(items).filter((i) => i.message.startsWith('Duplicate item'));
    expect(dupes.map((i) => i.itemId).sort()).toEqual(['a', 'b']);
    expect(dupes.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('flags a Story with missing acceptance criteria (but not other types)', () => {
    const items = [
      item({ id: 's', type: BacklogItemType.Story, title: 'Login', acceptanceCriteria: '' }),
      item({ id: 't', type: BacklogItemType.Task, title: 'Impl', acceptanceCriteria: '' }),
    ];
    const issues = validateBacklog(items);
    expect(
      issues.some(
        (i) => i.itemId === 's' && i.message.startsWith('Acceptance criteria are missing'),
      ),
    ).toBe(true);
    expect(issues.some((i) => i.itemId === 't' && i.message.includes('Acceptance criteria'))).toBe(
      false,
    );
  });

  it('does not flag missing AC when a Story has acceptance criteria', () => {
    const items = [
      item({ id: 's', type: BacklogItemType.Story, acceptanceCriteria: 'Given/When/Then' }),
    ];
    expect(validateBacklog(items).some((i) => i.message.includes('Acceptance criteria'))).toBe(
      false,
    );
  });

  it('detects a dependency cycle', () => {
    const items = [
      item({ id: 'a', type: BacklogItemType.Task, parentId: null, dependsOn: ['b'] }),
      item({ id: 'b', type: BacklogItemType.Task, parentId: null, dependsOn: ['a'] }),
    ];
    expect(validateBacklog(items).some((i) => i.message === 'Dependency cycle detected.')).toBe(
      true,
    );
  });
  const epic = item({ id: 'e', type: BacklogItemType.Epic, title: 'Epic' });
  const feature = item({ id: 'f', type: BacklogItemType.Feature, parentId: 'e', title: 'Feature' });
  const story = item({
    id: 's',
    type: BacklogItemType.Story,
    parentId: 'f',
    title: 'Story',
    acceptanceCriteria: 'Given/When/Then',
  });
  const task = item({ id: 't', type: BacklogItemType.Task, parentId: 's', title: 'Task' });
  const errorsOf = (items: BacklogItem[], ctx = {}) =>
    validateBacklog(items, ctx).filter((i) => i.severity === 'error');

  /**
   * The failure this prevents: a backlog in which 21 of 29 Stories had no Task passed every
   * structural rule, was approved, and reached Azure DevOps. The design system, the application
   * shell, the login screen and the entire task CRUD arrived as items no agent would ever pick
   * up — and every screen reported success.
   */
  describe('coverage — work that would never be built', () => {
    it('rejects a Story with no Task', () => {
      const errors = errorsOf([epic, feature, story]);
      expect(errors.map((e) => e.itemId)).toContain('s');
    });

    it('rejects a Feature with no Story', () => {
      expect(errorsOf([epic, feature]).map((e) => e.itemId)).toContain('f');
    });

    it('rejects an Epic with no Feature', () => {
      expect(errorsOf([epic]).map((e) => e.itemId)).toContain('e');
    });

    it('accepts a complete chain', () => {
      expect(errorsOf([epic, feature, story, task])).toEqual([]);
    });

    it('states the consequence, not the rule', () => {
      const issue = errorsOf([epic, feature, story]).find((i) => i.itemId === 's')!;
      expect(issue.message).toContain('Only a Task is dispatched to an agent');
    });
  });

  /**
   * The other silent killer: a Task naming a repository the project does not have resolves to no
   * repository at execution time and sits in To Do with no agent, which reads as a stuck board
   * rather than as a bad backlog.
   */
  describe('repository names', () => {
    const repos = [
      'https://dev.azure.com/org/Proj/_git/taskmanager-api',
      'https://dev.azure.com/org/Proj/_git/taskmanager-ui',
    ];
    const withRepo = (repo: string | null) => [epic, feature, story, { ...task, repo }];
    /*
     * These fixtures are two-repository projects, which also owe a browser journey and an
     * enforceable contract. Those are project-level rules with their own tests — they carry no
     * `itemId` — so the repository checks look only at the per-item errors they are about.
     */
    const repoErrors = (items: BacklogItem[]) =>
      errorsOf(items, { targetRepos: repos }).filter((e) => e.itemId !== null);

    it('accepts a Task naming one of the project repositories', () => {
      expect(repoErrors(withRepo('taskmanager-api'))).toEqual([]);
    });

    it('rejects an invented repository name and lists the real ones', () => {
      const errors = repoErrors(withRepo('backend-api'));
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('backend-api');
      expect(errors[0].message).toContain('taskmanager-api');
      expect(errors[0].message).toContain('taskmanager-ui');
    });

    /** "both" is the other thing agents write; one pod clones one repository. */
    it('rejects "both"', () => {
      expect(repoErrors(withRepo('both'))).toHaveLength(1);
    });

    it('rejects a Task with no repository at all', () => {
      expect(repoErrors(withRepo(null))[0].message).toContain('no repository');
    });

    /** Without the project's repositories there is nothing to check against; stay quiet. */
    it('says nothing when the project lists no repositories', () => {
      expect(errorsOf(withRepo('anything-at-all'))).toEqual([]);
    });
  });
  /**
   * Ordering. The failure this prevents: scaffolding Tasks sat 49th of 59, so a Prisma-model Task
   * ran before Prisma existed and scaffolded the whole project inside itself. The rule was in the
   * Scrum Master template; nothing checked it.
   */
  describe('foundation ordering', () => {
    const task = (id: string, title: string, order: number, repo = 'api') =>
      item({ id, type: BacklogItemType.Task, parentId: 's', title, order, repo });
    const tree = (...tasks: BacklogItem[]) => [
      item({ id: 'e', type: BacklogItemType.Epic, title: 'Epic' }),
      item({ id: 'f', type: BacklogItemType.Feature, parentId: 'e', title: 'Feature' }),
      item({
        id: 's',
        type: BacklogItemType.Story,
        parentId: 'f',
        title: 'Story',
        acceptanceCriteria: 'Given/When/Then',
      }),
      ...tasks,
    ];
    const errorsOf = (items: BacklogItem[]) =>
      validateBacklog(items).filter((i) => i.severity === 'error');

    it('rejects work sequenced before the repository is initialised', () => {
      const errors = errorsOf(
        tree(
          task('t1', 'Define User Prisma model and migration', 0),
          task('t2', 'Hash passwords with bcrypt', 1),
          task('t3', 'Initialize taskmanager-api Node/TS/Express project', 2),
        ),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].itemId).toBe('t3');
      expect(errors[0].message).toContain('2 api Task(s) are sequenced before');
    });

    it('accepts a backlog that scaffolds first', () => {
      expect(
        errorsOf(
          tree(
            task('t1', 'Initialize taskmanager-api Node/TS/Express project', 0),
            task('t2', 'Define User Prisma model and migration', 1),
          ),
        ),
      ).toEqual([]);
    });

    /** Each repository is sequenced independently. */
    it('checks every repository separately', () => {
      const errors = errorsOf(
        tree(
          task('t1', 'Initialize api project', 0, 'api'),
          task('t2', 'Build task list view', 1, 'ui'),
          task('t3', 'Set up React Router skeleton', 2, 'ui'),
        ),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('1 ui Task(s)');
    });

    it('says nothing when a repository has no foundation Task to sequence against', () => {
      expect(
        errorsOf(tree(task('t1', 'Add health-check endpoint', 0), task('t2', 'Add tests', 1))),
      ).toEqual([]);
    });

    /** Narrow on purpose: an ordinary Task must not be mistaken for scaffolding. */
    it('does not treat ordinary titles as foundation work', () => {
      expect(
        errorsOf(
          tree(task('t1', 'Set up the CORS allowlist', 0), task('t2', 'Initialize api project', 1)),
        ).map((e) => e.message),
      ).toEqual([
        '1 api Task(s) are sequenced before "Initialize api project" sets the repository up. Whichever runs first has to invent the project layout instead.',
      ]);
    });
  });
});

/**
 * A project split across repositories must test the seam between them, in a browser.
 *
 * Three defects survived every gate this project had, and all three lived between the two
 * applications: the API shipped with no CORS handling, so the browser blocked every call; the
 * interface's default pointed at a port the API did not listen on; the task list rendered blank
 * because it read a field the API never sent. Unit tests mock the API. API tests have no interface.
 * And the QA agent passed the "End-to-end verification" Story using `curl` — which never sends an
 * Origin header and never renders a table. Nothing could have caught them, so the backlog has to
 * ask for the one thing that can.
 */
describe('browser journey requirement', () => {
  const twoRepos = { targetRepos: ['https://x/_git/api', 'https://x/_git/ui'] };

  const story = (over: Partial<BacklogItem>): BacklogItem =>
    ({
      id: 's1',
      type: BacklogItemType.Story,
      title: 'A story',
      description: '',
      acceptanceCriteria: '- checkable',
      parentId: null,
      order: 0,
      priority: 2,
      estimate: null,
      dependsOn: [],
      repo: 'api',
      sprint: null,
      attachments: [],
      adoId: null,
      ...over,
    }) as BacklogItem;

  const browserIssue = (items: BacklogItem[], ctx: ValidationContext = twoRepos) =>
    validateBacklog(items, ctx).find((i) => /in a browser/i.test(i.message));

  it('blocks a multi-repository backlog with no browser journey anywhere', () => {
    const issue = browserIssue([story({})]);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('accepts one that names a browser journey in a title', () => {
    expect(browserIssue([story({ title: 'End-to-end journey in a browser' })])).toBeUndefined();
  });

  it('accepts one that names the tool in acceptance criteria', () => {
    expect(
      browserIssue([
        story({ acceptanceCriteria: '- A Playwright test registers, logs in and creates a task' }),
      ]),
    ).toBeUndefined();
  });

  it('accepts one that describes it in the description', () => {
    expect(
      browserIssue([story({ description: 'Drive the journey with Cypress against both apps' })]),
    ).toBeUndefined();
  });

  /** A single-repository project has no seam between applications, so nothing to require. */
  it('asks nothing of a single-repository project', () => {
    expect(browserIssue([story({})], { targetRepos: ['https://x/_git/only'] })).toBeUndefined();
  });

  it('asks nothing when the project declares no repositories at all', () => {
    expect(browserIssue([story({})], { targetRepos: [] })).toBeUndefined();
  });

  /**
   * Repositories are now created from the plan, *after* planning, so a backlog can be validated
   * before the project has any. The plan is what the repositories were derived from, so it answers
   * the same question — and without this the gate would silently stop firing under the new flow.
   */
  it('still applies when the plan describes two halves but no repository exists yet', () => {
    const issue = browserIssue([story({})], {
      targetRepos: [],
      planMarkdown: '## Architecture\n- A REST API serves the data.\n- A React UI shows screens.',
    });
    expect(issue).toBeDefined();
  });

  it('asks nothing when the plan describes an interface only', () => {
    expect(
      browserIssue([story({})], {
        targetRepos: [],
        planMarkdown: '## Overview\n- A single page that renders components in the browser.',
      }),
    ).toBeUndefined();
  });

  it('tells the reader what curl cannot see', () => {
    expect(browserIssue([story({})])?.message).toMatch(/CORS/);
  });
});

/**
 * Work the plan promised against a risk must exist in the backlog.
 *
 * The incident: the approved plan named the CORS risk precisely and said how to mitigate it. No
 * Story was ever drafted. The API shipped with no CORS handling and the interface could not call it
 * from a browser. The plan now says `mitigated by: <title>`, so this can check the work is there —
 * the plan check confirms a risk names work; this one confirms the work was drafted.
 */
describe('risk mitigations must be drafted', () => {
  const planWith = (mitigation: string) =>
    [
      '# Plan',
      '',
      '## Risks',
      '',
      `- CORS mismatch between the two apps — mitigated by: ${mitigation}`,
      '',
      '## Breakdown',
      '',
      `- Feature: ${mitigation}`,
    ].join(String.fromCharCode(10));

  const item = (title: string): BacklogItem =>
    ({
      id: 'f1',
      type: BacklogItemType.Feature,
      title,
      description: '',
      acceptanceCriteria: '',
      parentId: null,
      order: 0,
      priority: 2,
      estimate: null,
      dependsOn: [],
      repo: null,
      sprint: null,
      attachments: [],
      adoId: null,
    }) as BacklogItem;

  const mitigationIssues = (items: BacklogItem[], planMarkdown: string | null) =>
    validateBacklog(items, { planMarkdown }).filter((i) =>
      /risk\(s\) are mitigated/i.test(i.message),
    );

  it('blocks when the promised work is nowhere in the backlog', () => {
    const issues = mitigationIssues(
      [item('Something else')],
      planWith('Cross-origin configuration'),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('Cross-origin configuration');
  });

  it('accepts a backlog that contains the promised work', () => {
    expect(
      mitigationIssues(
        [item('Cross-origin configuration')],
        planWith('Cross-origin configuration'),
      ),
    ).toEqual([]);
  });

  it('matches the title regardless of case and punctuation', () => {
    expect(
      mitigationIssues(
        [item('CROSS-ORIGIN CONFIGURATION.')],
        planWith('Cross-origin configuration'),
      ),
    ).toEqual([]);
  });

  /** Callers with no plan to hand (the board's ad-hoc validate) must not be blocked by this. */
  it('asks nothing when no plan was supplied', () => {
    expect(mitigationIssues([item('Something else')], null)).toEqual([]);
  });
});

/**
 * The shared contract must be enforced by something, not merely written.
 *
 * The incident: the project produced a correct OpenAPI contract. The API followed it and returned
 * `{ tasks: [...] }`. The interface hand-wrote its types, expected a bare array, and rendered an
 * empty page. Both repositories compiled; both test suites passed, because the interface tests mock
 * the API and the mock returned what the interface already believed. A document nothing checks is a
 * document two codebases can quietly disagree with.
 */
describe('contract must be enforceable', () => {
  const twoRepos = { targetRepos: ['https://x/_git/api', 'https://x/_git/ui'] };

  const story = (over: Partial<BacklogItem>): BacklogItem =>
    ({
      id: 's1',
      type: BacklogItemType.Story,
      title: 'A story',
      description: '',
      acceptanceCriteria: '- checkable',
      parentId: null,
      order: 0,
      priority: 2,
      estimate: null,
      dependsOn: [],
      repo: 'api',
      sprint: null,
      attachments: [],
      adoId: null,
      ...over,
    }) as BacklogItem;

  const contractIssue = (items: BacklogItem[], ctx = twoRepos) =>
    validateBacklog(items, ctx).find((i) => /contract enforceable/i.test(i.message));

  it('blocks a multi-repository backlog with nothing enforcing the contract', () => {
    const issue = contractIssue([story({})]);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  /** A contract that is only written down is exactly the case that failed. */
  it('is not satisfied by merely authoring the contract document', () => {
    expect(
      contractIssue([story({ title: 'Write the shared API contract document' })]),
    ).toBeDefined();
  });

  it('accepts generated types from the contract', () => {
    expect(
      contractIssue([story({ title: 'Generate frontend API types from the OpenAPI contract' })]),
    ).toBeUndefined();
  });

  it('accepts response validation against the contract', () => {
    expect(
      contractIssue([
        story({
          title: 'Contract tests',
          acceptanceCriteria: '- Every API response is validated against the OpenAPI schema',
        }),
      ]),
    ).toBeUndefined();
  });

  /** One repository has no seam for two codebases to disagree across. */
  it('asks nothing of a single-repository project', () => {
    expect(contractIssue([story({})], { targetRepos: ['https://x/_git/only'] })).toBeUndefined();
  });

  it('explains what went wrong last time', () => {
    expect(contractIssue([story({})])?.message).toContain('empty page');
  });
});

/**
 * No work may be scheduled before the work it belongs to.
 *
 * Found on a real backlog: a Task in Sprint 2 whose Story sat in Sprint 3. Nothing else catches it
 * — every item is individually valid, the parent link is right, and both sprints exist — so it
 * reaches the board and a developer picks up work with nothing to attach it to.
 */
describe('sprint ordering', () => {
  const item = (over: Partial<BacklogItem>): BacklogItem =>
    ({
      id: 'x',
      type: BacklogItemType.Task,
      title: 'Some work',
      description: '',
      acceptanceCriteria: 'Does the thing',
      parentId: null,
      repo: 'ui',
      sprint: 'Sprint 1',
      dependsOn: [],
      attachments: [],
      ...over,
    }) as BacklogItem;

  const orderIssue = (items: BacklogItem[]) =>
    validateBacklog(items).find((i) => /before its parent/i.test(i.message));

  const story = (sprint: string | null) =>
    item({ id: 's1', type: BacklogItemType.Story, title: 'Settings drawer', sprint });

  it('blocks a task scheduled before its story', () => {
    const issue = orderIssue([
      story('Sprint 3'),
      item({ id: 't1', parentId: 's1', sprint: 'Sprint 2' }),
    ]);
    expect(issue?.itemId).toBe('t1');
  });

  it('names the parent and both sprints, so the fix is obvious', () => {
    const issue = orderIssue([
      story('Sprint 3'),
      item({ id: 't1', parentId: 's1', sprint: 'Sprint 2' }),
    ]);
    expect(issue?.message).toContain('Settings drawer');
    expect(issue?.message).toContain('Sprint 2');
    expect(issue?.message).toContain('Sprint 3');
  });

  it('allows a task in the same sprint as its story', () => {
    expect(
      orderIssue([story('Sprint 3'), item({ id: 't1', parentId: 's1', sprint: 'Sprint 3' })]),
    ).toBeUndefined();
  });

  /** Later is fine — a Story can span sprints. */
  it('allows a task in a later sprint than its story', () => {
    expect(
      orderIssue([story('Sprint 2'), item({ id: 't1', parentId: 's1', sprint: 'Sprint 4' })]),
    ).toBeUndefined();
  });

  /** Features and Epics carry no sprint of their own; that is not a violation. */
  it('says nothing when the parent has no sprint', () => {
    expect(
      orderIssue([story(null), item({ id: 't1', parentId: 's1', sprint: 'Sprint 1' })]),
    ).toBeUndefined();
  });

  /**
   * The cross-branch case, which parent/child cannot see. On the real backlog a Settings toggle
   * sat a sprint before the Settings drawer it lives in, and a counter was built to read a store
   * written a sprint later — neither is a parent/child mistake.
   */
  it('blocks an item scheduled before something it depends on', () => {
    const issue = validateBacklog([
      item({
        id: 'drawer',
        type: BacklogItemType.Story,
        title: 'Settings drawer',
        sprint: 'Sprint 3',
      }),
      item({
        id: 'toggle',
        type: BacklogItemType.Story,
        title: 'Sound toggle',
        sprint: 'Sprint 2',
        dependsOn: ['drawer'],
      }),
    ]).find((i) => /depends on/i.test(i.message));
    expect(issue?.itemId).toBe('toggle');
    expect(issue?.message).toContain('Settings drawer');
  });

  it('allows a dependency in the same sprint', () => {
    expect(
      validateBacklog([
        item({ id: 'drawer', type: BacklogItemType.Story, sprint: 'Sprint 3' }),
        item({
          id: 'toggle',
          type: BacklogItemType.Story,
          sprint: 'Sprint 3',
          dependsOn: ['drawer'],
        }),
      ]).find((i) => /depends on/i.test(i.message)),
    ).toBeUndefined();
  });

  /** A dependency on something not in the backlog is a different problem, not this one. */
  it('says nothing about a dependency that is not in the backlog', () => {
    expect(
      validateBacklog([
        item({
          id: 'toggle',
          type: BacklogItemType.Story,
          sprint: 'Sprint 1',
          dependsOn: ['nope'],
        }),
      ]).find((i) => /depends on/i.test(i.message)),
    ).toBeUndefined();
  });

  /** A backlog that names its sprints some other way is left alone rather than guessed at. */
  it('says nothing about sprints that are not numbered', () => {
    expect(
      orderIssue([
        item({ id: 's1', type: BacklogItemType.Story, sprint: 'Hardening' }),
        item({ id: 't1', parentId: 's1', sprint: 'Discovery' }),
      ]),
    ).toBeUndefined();
  });
});

/**
 * Acceptance criteria have to be about the item they are attached to.
 *
 * A real backlog had its CRUD criteria shifted by one — the `PUT` Story carried create criteria,
 * the `DELETE` Story carried update criteria, and delete had none of its own. Every other gate
 * passed, because every criterion was individually well-formed.
 */
describe('acceptance criteria matching the item', () => {
  const story = (title: string, acceptanceCriteria: string): BacklogItem =>
    ({
      id: 's1',
      type: BacklogItemType.Story,
      title,
      description: '',
      acceptanceCriteria,
      parentId: null,
      repo: 'ui',
      sprint: 'Sprint 1',
      dependsOn: [],
      attachments: [],
    }) as unknown as BacklogItem;

  const mismatch = (items: BacklogItem[]) =>
    validateBacklog(items).find((i) => /acceptance criteria describe/i.test(i.message));

  it('blocks an update Story whose criteria describe creating', () => {
    const issue = mismatch([
      story(
        'PUT /employees/:id (update) with backend validation',
        '- returns 201 with the created employee',
      ),
    ]);
    expect(issue?.itemId).toBe('s1');
    expect(issue?.message).toMatch(/creating/);
  });

  it('explains why it matters, so the fix is obvious', () => {
    const issue = mismatch([
      story('DELETE /employees/:id', '- updates the employee and returns 200'),
    ]);
    expect(issue?.message).toMatch(/QA verifies against these criteria/i);
  });

  it('accepts criteria that match', () => {
    expect(
      mismatch([story('DELETE /employees/:id', '- deletes the employee and returns 204')]),
    ).toBeUndefined();
  });

  /** A Task's title is a note to whoever picks it up, not a claim about a resource. */
  it('does not hold an ordinary Task title to its words', () => {
    const task = {
      ...story('Add response-schema validation tests', '- fails if a field is removed'),
      id: 't1',
      type: BacklogItemType.Task,
    } as unknown as BacklogItem;
    expect(mismatch([task])).toBeUndefined();
  });

  /** A Task naming an HTTP method is unambiguous, so it is held to it. */
  it('does hold a Task that names an HTTP method', () => {
    const task = {
      ...story('Implement DELETE /employees/:id', '- updates the employee and returns 200'),
      id: 't1',
      type: BacklogItemType.Task,
    } as unknown as BacklogItem;
    expect(mismatch([task])?.itemId).toBe('t1');
  });
});

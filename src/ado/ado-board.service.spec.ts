import { AdoBoardService, normalizeTaskState } from './ado-board.service';
import { AdoWorkItem } from './ado.types';
import { SprintContext } from './sprint.service';
import { BacklogItem, BacklogItemType } from '../planning/schemas/draft.schema';
import { JobDocument } from '../jobs/schemas/job.schema';
import { ProjectDocument } from '../projects/schemas/project.schema';

/**
 * Unit tests for the **task-centric** Development board projection: only Tasks become cards, each
 * carrying its Epic → Feature → Story context, bucketed into the normalized
 * `Draft → To Do → In Progress → Done` columns (a presentation mapping — raw ADO states are never
 * rewritten).
 */
/** One target repo ⇒ every Task resolves an execution agent. */
const project = {
  targetRepos: ['https://dev.azure.com/org/proj/_git/repo'],
  adoTarget: { project: 'Proj' },
} as unknown as ProjectDocument;

const noSprints: SprintContext = { currentSprint: null, frames: new Map() };

const tasksFromAdo = (
  items: AdoWorkItem[],
  running: ReadonlySet<string> = new Set(),
  latestRuns: ReadonlyMap<string, JobDocument> = new Map(),
) =>
  AdoBoardService.tasksFromAdo(items, running, { project, sprintContext: noSprints, latestRuns });

const tasksFromDraft = (backlog: BacklogItem[]) => AdoBoardService.tasksFromDraft(backlog, project);

const wi = (
  id: number,
  type: string,
  state: string,
  over: Record<string, unknown> = {},
): AdoWorkItem => ({
  id,
  url: `https://dev.azure.com/org/_apis/wit/workItems/${id}`,
  fields: {
    'System.Id': id,
    'System.Title': `${type} ${id}`,
    'System.WorkItemType': type,
    'System.State': state,
    ...over,
  },
});

/** Epic 1 → Feature 2 → Story 3 → Task 4 (a complete hierarchy). */
const hierarchy: AdoWorkItem[] = [
  wi(1, 'Epic', 'New'),
  wi(2, 'Feature', 'New', { 'System.Parent': 1 }),
  wi(3, 'Product Backlog Item', 'Committed', { 'System.Parent': 2 }),
  wi(4, 'Task', 'To Do', { 'System.Parent': 3 }),
];

const backlogItem = (over: Partial<BacklogItem> & Pick<BacklogItem, 'id' | 'type'>): BacklogItem =>
  ({
    title: `item ${over.id}`,
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
    ...over,
  }) as BacklogItem;

describe('normalizeTaskState', () => {
  it('maps the Scrum Task states onto the normalized workflow', () => {
    expect(normalizeTaskState('To Do')).toBe('To Do');
    expect(normalizeTaskState('In Progress')).toBe('In Progress');
    expect(normalizeTaskState('Done')).toBe('Done');
  });

  it('accepts Agile/Basic aliases for the same execution states', () => {
    expect(normalizeTaskState('New')).toBe('To Do');
    expect(normalizeTaskState('Active')).toBe('In Progress');
    expect(normalizeTaskState('Closed')).toBe('Done');
  });

  it('is case/whitespace insensitive', () => {
    expect(normalizeTaskState('  in progress ')).toBe('In Progress');
  });

  it('drops cancelled work (Removed) so it never reaches the board', () => {
    expect(normalizeTaskState('Removed')).toBeNull();
  });

  it('treats an absent state as Draft (not created in ADO yet)', () => {
    expect(normalizeTaskState(null)).toBe('Draft');
  });

  it('falls back to Draft for an unrecognised state so the Task stays visible', () => {
    expect(normalizeTaskState('SomeCustomState')).toBe('Draft');
  });
});

describe('AdoBoardService.tasksFromAdo', () => {
  it('emits ONLY Task cards — Epics, Features and Stories are never cards', () => {
    const tasks = tasksFromAdo(hierarchy, new Set());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].adoId).toBe(4);
  });

  /**
   * A Developer agent is dispatched on Tasks **and** on Bugs QA filed (D-019/D-028), so a Bug is a
   * card like any other — with its own type, its Story's context, and the Bug state vocabulary
   * (`New` = To Do, `Committed` = In Progress).
   */
  describe('Bug cards', () => {
    const withBug = [
      wi(1, 'Epic', 'New'),
      wi(2, 'Feature', 'New', { 'System.Parent': 1 }),
      wi(3, 'Product Backlog Item', 'Committed', { 'System.Parent': 2 }),
      wi(4, 'Task', 'Done', { 'System.Parent': 3 }),
      wi(5, 'Bug', 'New', { 'System.Parent': 3 }),
    ];

    it('emits a Bug as its own card, tagged as a bug', () => {
      const cards = tasksFromAdo(withBug, new Set());
      const bug = cards.find((c) => c.adoId === 5);
      expect(bug).toBeDefined();
      expect(bug?.kind).toBe('bug');
      expect(cards.find((c) => c.adoId === 4)?.kind).toBe('task');
    });

    it('gives the Bug the same Epic → Feature → Story context as a Task', () => {
      const bug = tasksFromAdo(withBug, new Set()).find((c) => c.adoId === 5);
      expect(bug?.story?.title).toBe('Product Backlog Item 3');
      expect(bug?.feature?.title).toBe('Feature 2');
      expect(bug?.epic?.title).toBe('Epic 1');
    });

    /**
     * A Bug inherits the repository of the Story it was found in.
     *
     * QA files Bugs through the Azure DevOps MCP and tags them with the repo — most of the time.
     * On a two-repository project an untagged Bug resolves to no execution agent, so the board
     * refused to start a fix: "No execution agent is assigned to this Task". Four of seventeen real
     * Bugs landed that way. The Story above it always knows the answer, so the Bug asks it.
     */
    it('inherits the repo from its Story when QA did not tag it', () => {
      const twoRepos = {
        targetRepos: [
          'https://dev.azure.com/org/proj/_git/api',
          'https://dev.azure.com/org/proj/_git/ui',
        ],
        adoTarget: { project: 'Proj' },
      } as unknown as ProjectDocument;
      const items = [
        wi(1, 'Epic', 'New'),
        wi(2, 'Feature', 'New', { 'System.Parent': 1 }),
        wi(3, 'Product Backlog Item', 'Committed', {
          'System.Parent': 2,
          'System.Tags': 'repo:api',
        }),
        wi(5, 'Bug', 'New', { 'System.Parent': 3 }), // no tag of its own
      ];
      const cards = AdoBoardService.tasksFromAdo(items, new Set(), {
        project: twoRepos,
        sprintContext: noSprints,
        latestRuns: new Map(),
      });
      const bug = cards.find((c) => c.adoId === 5);
      expect(bug?.repo).toBe('https://dev.azure.com/org/proj/_git/api');
      expect(bug?.executionAgent).not.toBeNull();
    });

    it('prefers a tag on the Bug itself over the one it would inherit', () => {
      const twoRepos = {
        targetRepos: [
          'https://dev.azure.com/org/proj/_git/api',
          'https://dev.azure.com/org/proj/_git/ui',
        ],
        adoTarget: { project: 'Proj' },
      } as unknown as ProjectDocument;
      const items = [
        wi(3, 'Product Backlog Item', 'Committed', { 'System.Tags': 'repo:api' }),
        wi(5, 'Bug', 'New', { 'System.Parent': 3, 'System.Tags': 'repo:ui' }),
      ];
      const cards = AdoBoardService.tasksFromAdo(items, new Set(), {
        project: twoRepos,
        sprintContext: noSprints,
        latestRuns: new Map(),
      });
      expect(cards.find((c) => c.adoId === 5)?.repo).toBe('https://dev.azure.com/org/proj/_git/ui');
    });

    /** Nothing up the chain knows either — the honest answer is still "no agent". */
    it('leaves a Bug with no tagged ancestor without an execution agent', () => {
      const twoRepos = {
        targetRepos: [
          'https://dev.azure.com/org/proj/_git/api',
          'https://dev.azure.com/org/proj/_git/ui',
        ],
        adoTarget: { project: 'Proj' },
      } as unknown as ProjectDocument;
      const cards = AdoBoardService.tasksFromAdo(
        [wi(3, 'Product Backlog Item', 'Committed'), wi(5, 'Bug', 'New', { 'System.Parent': 3 })],
        new Set(),
        { project: twoRepos, sprintContext: noSprints, latestRuns: new Map() },
      );
      expect(cards.find((c) => c.adoId === 5)?.executionAgent).toBeNull();
    });

    /**
     * A reopened Bug belongs in To Do, where it can be acted on.
     *
     * `Committed` on a Bug means the orchestrator dispatched a pod for it. A QA agent rejecting a
     * fix reopens the Bug to `Committed` as well, and then nothing is running — so Bug #628 sat in
     * the In Progress column for ten hours with no action available. The column now follows the
     * live run rather than a state that had stopped being true.
     */
    it('shows a Committed Bug with no run in To Do, not In Progress', () => {
      const cards = tasksFromAdo([wi(5, 'Bug', 'Committed')], new Set());
      expect(cards[0].status).toBe('To Do');
      expect(cards[0].canTransition.allowed).toBe(true);
    });

    it('keeps a Committed Bug in In Progress while its Developer run is live', () => {
      const cards = tasksFromAdo([wi(5, 'Bug', 'Committed')], new Set(['5']));
      expect(cards[0].status).toBe('In Progress');
    });

    /** A Task's Committed is not the same story — only Bugs get this treatment. */
    it('leaves an in-progress Task where it is', () => {
      const cards = tasksFromAdo([wi(4, 'Task', 'In Progress')], new Set());
      expect(cards[0].status).toBe('In Progress');
    });

    it('maps the Bug state vocabulary onto the board columns', () => {
      // #6 is Committed *and* running, which is the case where Committed means In Progress. A
      // Committed Bug with no run is a reopened one and belongs in To Do — covered just above.
      const cards = tasksFromAdo(
        [wi(5, 'Bug', 'New'), wi(6, 'Bug', 'Committed'), wi(7, 'Bug', 'Done')],
        new Set(['6']),
      );
      expect(cards.map((c) => c.status)).toEqual(['To Do', 'In Progress', 'Done']);
    });

    it('offers a Bug in New the same forward move a To Do Task gets', () => {
      const bug = tasksFromAdo([wi(5, 'Bug', 'New')], new Set())[0];
      expect(bug.canTransition.to).toBe('In Progress');
    });
  });

  it('resolves the full Epic → Feature → Story context onto the Task', () => {
    const [task] = tasksFromAdo(hierarchy, new Set());
    expect(task.story?.title).toBe('Product Backlog Item 3');
    expect(task.feature?.title).toBe('Feature 2');
    expect(task.epic?.title).toBe('Epic 1');
  });

  it('resolves ancestors by type, so a missing level does not shift the others', () => {
    // Task → Feature directly (no Story in between).
    const [task] = tasksFromAdo(
      [
        wi(1, 'Epic', 'New'),
        wi(2, 'Feature', 'New', { 'System.Parent': 1 }),
        wi(9, 'Task', 'To Do', { 'System.Parent': 2 }),
      ],
      new Set(),
    );
    expect(task.story).toBeNull();
    expect(task.feature?.title).toBe('Feature 2');
    expect(task.epic?.title).toBe('Epic 1');
  });

  it('keeps a Story with many Tasks as many individual Task cards', () => {
    const items = [
      wi(1, 'Product Backlog Item', 'Committed'),
      ...Array.from({ length: 10 }, (_, i) => wi(100 + i, 'Task', 'Done', { 'System.Parent': 1 })),
    ];
    const tasks = tasksFromAdo(items, new Set());
    expect(tasks).toHaveLength(10);
    expect(new Set(tasks.map((t) => t.story?.title))).toEqual(new Set(['Product Backlog Item 1']));
  });

  it('excludes Removed Tasks', () => {
    expect(tasksFromAdo([wi(5, 'Task', 'Removed')], new Set())).toHaveLength(0);
  });

  it('flags a Task with an active Developer run and carries sprint + assignee', () => {
    const [task] = tasksFromAdo(
      [
        wi(7, 'Task', 'In Progress', {
          'System.IterationPath': 'Proj\\Sprint 4',
          'System.AssignedTo': { displayName: 'Dev One', uniqueName: 'dev@x.io' },
        }),
      ],
      new Set(['7']),
    );
    expect(task.agentRunning).toBe(true);
    expect(task.sprint).toBe('Sprint 4'); // leaf of the iteration path
    expect(task.assignee).toBe('Dev One');
  });

  it('treats the bare project root iteration as "no sprint"', () => {
    const [task] = tasksFromAdo(
      [wi(8, 'Task', 'To Do', { 'System.IterationPath': 'Proj' })],
      new Set(),
    );
    expect(task.sprint).toBeNull();
  });
});

describe('AdoBoardService.tasksFromDraft', () => {
  it('shows backlog Tasks not yet pushed to ADO as Draft, with local hierarchy', () => {
    const backlog = [
      backlogItem({ id: 'e', type: BacklogItemType.Epic, title: 'Scaffolding' }),
      backlogItem({ id: 'f', type: BacklogItemType.Feature, title: 'Tooling', parentId: 'e' }),
      backlogItem({ id: 's', type: BacklogItemType.Story, title: 'Init', parentId: 'f' }),
      backlogItem({ id: 't', type: BacklogItemType.Task, title: 'Add ESLint', parentId: 's' }),
    ];
    const tasks = tasksFromDraft(backlog);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      adoId: null,
      title: 'Add ESLint',
      status: 'Draft',
      state: null,
    });
    expect(tasks[0].story?.title).toBe('Init');
    expect(tasks[0].feature?.title).toBe('Tooling');
    expect(tasks[0].epic?.title).toBe('Scaffolding');
  });

  it('ignores backlog Tasks that are already in ADO (they come from the ADO projection)', () => {
    const backlog = [backlogItem({ id: 't', type: BacklogItemType.Task, adoId: 42 })];
    expect(tasksFromDraft(backlog)).toHaveLength(0);
  });

  it('ignores non-Task backlog items', () => {
    const backlog = [
      backlogItem({ id: 'e', type: BacklogItemType.Epic }),
      backlogItem({ id: 's', type: BacklogItemType.Story }),
    ];
    expect(tasksFromDraft(backlog)).toHaveLength(0);
  });
});

describe('AdoBoardService.groupByStatus', () => {
  it('always returns the four workflow columns in order, even when empty', () => {
    expect(AdoBoardService.groupByStatus([]).map((c) => c.status)).toEqual([
      'Draft',
      'To Do',
      'In Progress',
      'Done',
    ]);
  });

  it('buckets each Task into its normalized column', () => {
    const tasks = tasksFromAdo(
      [wi(1, 'Task', 'To Do'), wi(2, 'Task', 'In Progress'), wi(3, 'Task', 'Done')],
      new Set(),
    );
    const byStatus = Object.fromEntries(
      AdoBoardService.groupByStatus(tasks).map((c) => [c.status, c.tasks.map((t) => t.adoId)]),
    );
    expect(byStatus).toEqual({ Draft: [], 'To Do': [1], 'In Progress': [2], Done: [3] });
  });

  it('orders cards by ADO id — the order the Developer batch dispatches them in', () => {
    const tasks = tasksFromAdo(
      [wi(30, 'Task', 'To Do'), wi(10, 'Task', 'To Do'), wi(20, 'Task', 'To Do')],
      new Set(),
    );
    const todo = AdoBoardService.groupByStatus(tasks).find((c) => c.status === 'To Do');
    expect(todo?.tasks.map((t) => t.adoId)).toEqual([10, 20, 30]);
  });
});

/**
 * A project may hold an initial plan and its enhancements, and the board shows them all.
 *
 * The trap: draft ids are unique only *within* a plan. Two plans can each have a `story-1`. If the
 * board merged the backlogs before resolving the hierarchy, an enhancement's Task would attach
 * itself to whichever `story-1` happened to be indexed last — showing a parent that is not its
 * parent, on a board whose whole job is to say what belongs to what.
 *
 * `getBoard` therefore resolves **one plan at a time** and concatenates the cards. These tests pin
 * both halves: that it works, and that the merged-first alternative really would be wrong.
 */
describe('a board built from more than one plan', () => {
  const originalPlan = [
    backlogItem({ id: 'story-1', type: BacklogItemType.Story, title: 'Login screen' }),
    backlogItem({
      id: 'task-1',
      type: BacklogItemType.Task,
      title: 'Build the login form',
      parentId: 'story-1',
    }),
  ];

  /** Same ids, different work — exactly what a second planning cycle produces. */
  const enhancement = [
    backlogItem({ id: 'story-1', type: BacklogItemType.Story, title: 'Dark mode' }),
    backlogItem({
      id: 'task-1',
      type: BacklogItemType.Task,
      title: 'Add the theme toggle',
      parentId: 'story-1',
    }),
  ];

  it('shows the Tasks of every plan', () => {
    const cards = [originalPlan, enhancement].flatMap(tasksFromDraft);
    expect(cards.map((c) => c.title)).toEqual(['Build the login form', 'Add the theme toggle']);
  });

  it('keeps each Task under its own plan’s Story', () => {
    const cards = [originalPlan, enhancement].flatMap(tasksFromDraft);
    expect(cards[0].story?.title).toBe('Login screen');
    expect(cards[1].story?.title).toBe('Dark mode');
  });

  /** The alternative, shown to be wrong: merge the backlogs and a Task gets the wrong parent. */
  it('would attach a Task to the wrong Story if the plans were merged first', () => {
    const merged = tasksFromDraft([...originalPlan, ...enhancement]);
    const titles = merged.map((c) => c.story?.title);
    expect(new Set(titles).size).toBe(1); // both Tasks ended up under one Story
  });
});

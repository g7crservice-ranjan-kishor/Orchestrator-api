import { BacklogItem, BacklogItemType } from '../planning/schemas/draft.schema';
import { AdoPushContext, JsonPatchOperation } from './ado.types';
import { adoTypeFor, buildCreatePatch, orderParentsFirst } from './draft-to-ado.mapper';

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
    adoId: null,
    ...over,
  } as BacklogItem;
}

const ctx: AdoPushContext = {
  owner: 'project-1',
  orgUrl: 'https://dev.azure.com/org',
  project: 'Proj',
  areaPath: 'Proj\\Area',
  defaultIterationPath: 'Proj',
  developerAssignee: 'dev@x.io',
  // Resolved from the project before the push; 'Approved' is what a Scrum process reports.
  storyReadyState: 'Approved',
};

const valueAt = (ops: JsonPatchOperation[], path: string): unknown =>
  ops.find((o) => o.path === path)?.value;

describe('adoTypeFor', () => {
  it('maps framework types to ADO Scrum types', () => {
    expect(adoTypeFor(BacklogItemType.Epic)).toBe('Epic');
    expect(adoTypeFor(BacklogItemType.Feature)).toBe('Feature');
    expect(adoTypeFor(BacklogItemType.Story)).toBe('Product Backlog Item');
    expect(adoTypeFor(BacklogItemType.Task)).toBe('Task');
  });
});

describe('buildCreatePatch', () => {
  it('sets title, area path, iteration, and priority', () => {
    const ops = buildCreatePatch(
      item({ id: 's', type: BacklogItemType.Story, title: 'Login' }),
      ctx,
      null,
    );
    expect(valueAt(ops, '/fields/System.Title')).toBe('Login');
    expect(valueAt(ops, '/fields/System.AreaPath')).toBe('Proj\\Area');
    expect(valueAt(ops, '/fields/System.IterationPath')).toBe('Proj');
    expect(valueAt(ops, '/fields/Microsoft.VSTS.Common.Priority')).toBe(2);
  });

  it('uses the item sprint as the iteration path when set', () => {
    const ops = buildCreatePatch(
      item({ id: 't', type: BacklogItemType.Task, sprint: 'Proj\\Sprint 2' }),
      ctx,
      null,
    );
    expect(valueAt(ops, '/fields/System.IterationPath')).toBe('Proj\\Sprint 2');
  });

  it('prefixes a bare sprint leaf with the project (ADO rejects a bare iteration name)', () => {
    const ops = buildCreatePatch(
      item({ id: 't', type: BacklogItemType.Task, sprint: 'Sprint 4' }),
      ctx,
      null,
    );
    expect(valueAt(ops, '/fields/System.IterationPath')).toBe('Proj\\Sprint 4');
  });

  it('puts acceptance criteria on Stories and Tasks (required), not on Epics/Features', () => {
    const story = buildCreatePatch(
      item({ id: 's', type: BacklogItemType.Story, acceptanceCriteria: 'AC' }),
      ctx,
      null,
    );
    expect(valueAt(story, '/fields/Microsoft.VSTS.Common.AcceptanceCriteria')).toBe('AC');
    // Required on Tasks too in this process; missing criteria fall back rather than 400.
    const task = buildCreatePatch(item({ id: 't', type: BacklogItemType.Task }), ctx, null);
    expect(valueAt(task, '/fields/Microsoft.VSTS.Common.AcceptanceCriteria')).toBe(
      'To be defined.',
    );
    const epic = buildCreatePatch(
      item({ id: 'e', type: BacklogItemType.Epic, acceptanceCriteria: 'AC' }),
      ctx,
      null,
    );
    expect(valueAt(epic, '/fields/Microsoft.VSTS.Common.AcceptanceCriteria')).toBeUndefined();
  });

  it('populates the process-required fields per type (Value Area, dates, Effort, Activity)', () => {
    const iso = /^\d{4}-\d{2}-\d{2}T/;

    const epic = buildCreatePatch(item({ id: 'e', type: BacklogItemType.Epic }), ctx, null);
    expect(valueAt(epic, '/fields/Microsoft.VSTS.Common.ValueArea')).toBe('Business');
    expect(valueAt(epic, '/fields/Microsoft.VSTS.Scheduling.StartDate')).toMatch(iso);
    expect(valueAt(epic, '/fields/Microsoft.VSTS.Scheduling.TargetDate')).toMatch(iso);
    expect(valueAt(epic, '/fields/System.Description')).toBe('T'); // falls back to the title

    const story = buildCreatePatch(item({ id: 's', type: BacklogItemType.Story }), ctx, null);
    expect(valueAt(story, '/fields/Microsoft.VSTS.Scheduling.Effort')).toBe(1);
    expect(valueAt(story, '/fields/Microsoft.VSTS.Common.ValueArea')).toBe('Business');

    const task = buildCreatePatch(item({ id: 't', type: BacklogItemType.Task }), ctx, null);
    expect(valueAt(task, '/fields/Microsoft.VSTS.Common.Activity')).toBe('Development');
    // Tasks are not portfolio items — no Start/Target dates or Value Area.
    expect(valueAt(task, '/fields/Microsoft.VSTS.Scheduling.StartDate')).toBeUndefined();
    expect(valueAt(task, '/fields/Microsoft.VSTS.Common.ValueArea')).toBeUndefined();
  });

  it('tags the repo on a Task, and assigns it', () => {
    const task = buildCreatePatch(
      item({ id: 't', type: BacklogItemType.Task, repo: 'api' }),
      ctx,
      null,
    );
    expect(valueAt(task, '/fields/System.AssignedTo')).toBe('dev@x.io');
    expect(valueAt(task, '/fields/System.Tags')).toBe('repo:api');
  });

  /**
   * QA works on Stories, and resolves the repository to clone from this tag.
   *
   * The tag used to be written on Tasks only — "a Story routes no work of its own". That held
   * while a project had one repository, because the resolver falls back to the sole target. On a
   * two-repository project the fallback cannot choose, so every Story was rejected as "no target
   * repository resolvable", the QA wave dispatched nothing, and the board showed no reason why.
   */
  it('tags the repo on a Story, because QA resolves the repo from it', () => {
    const story = buildCreatePatch(
      item({ id: 's', type: BacklogItemType.Story, repo: 'api' }),
      ctx,
      null,
    );
    expect(valueAt(story, '/fields/System.Tags')).toBe('repo:api');
  });

  /**
   * The second half of the same failure. A Story whose Tasks span *both* repositories has no
   * repository of its own, so tagging "the item's repo" still wrote nothing and those Stories were
   * rejected exactly as before. The push now works one out from the Story's children and passes it
   * in (see repo-inheritance.ts).
   */
  it('tags a Story with the repository the push worked out for it', () => {
    const story = buildCreatePatch(
      item({ id: 's', type: BacklogItemType.Story }),
      ctx,
      null,
      'employee-management-system-api',
    );
    expect(valueAt(story, '/fields/System.Tags')).toBe('repo:employee-management-system-api');
  });

  it("prefers the passed repository over the item's own", () => {
    const story = buildCreatePatch(
      item({ id: 's', type: BacklogItemType.Story, repo: 'api' }),
      ctx,
      null,
      'ui',
    );
    expect(valueAt(story, '/fields/System.Tags')).toBe('repo:ui');
  });

  it('leaves an item with no repo untagged', () => {
    const story = buildCreatePatch(item({ id: 's', type: BacklogItemType.Story }), ctx, null);
    expect(valueAt(story, '/fields/System.Tags')).toBeUndefined();
  });

  /** An Epic routes no work and is never cloned, so it carries no repo tag. */
  it('tags an Epic when the plan gave it a repo, and not otherwise', () => {
    const epic = buildCreatePatch(item({ id: 'e', type: BacklogItemType.Epic }), ctx, null);
    expect(valueAt(epic, '/fields/System.Tags')).toBeUndefined();
  });

  /**
   * A push happens only after a human approved the draft. Creating PBIs in `New` would make them
   * re-approve every Story in Azure DevOps before its Tasks could run, since the Development board
   * refuses a Task whose parent Story is not Approved or Committed.
   */
  describe('Story approval', () => {
    /**
     * Azure DevOps validates State differently on a create than on an ordinary transition. It
     * reported that a Product Backlog Item supports `New, Approved, Committed, Done, Removed`, and
     * then rejected a create carrying `Approved` as "not in the list of supported values" — the
     * same value, from the same project, in the same breath. The push creates the item and moves
     * it afterwards instead, which is the call the task board already makes every day.
     */
    it('never sets the state on the create itself', () => {
      const story = buildCreatePatch(item({ id: 's', type: BacklogItemType.Story }), ctx, null);
      expect(valueAt(story, '/fields/System.State')).toBeUndefined();
    });

    it('assigns the Story as it creates it', () => {
      const story = buildCreatePatch(item({ id: 's', type: BacklogItemType.Story }), ctx, null);
      expect(valueAt(story, '/fields/System.AssignedTo')).toBe('dev@x.io');
    });

    it('omits the assignee when none is configured', () => {
      const story = buildCreatePatch(
        item({ id: 's', type: BacklogItemType.Story }),
        { ...ctx, developerAssignee: null },
        null,
      );
      expect(valueAt(story, '/fields/System.AssignedTo')).toBeUndefined();
    });

    /** Whatever the project reported, it is still never written on the create. */
    it('sets no state even when the project reported one', () => {
      const story = buildCreatePatch(
        item({ id: 's', type: BacklogItemType.Story }),
        { ...ctx, storyReadyState: 'Ready for Dev' },
        null,
      );
      expect(valueAt(story, '/fields/System.State')).toBeUndefined();
    });

    it('leaves every other type in its default state', () => {
      for (const type of [BacklogItemType.Epic, BacklogItemType.Feature, BacklogItemType.Task]) {
        const patch = buildCreatePatch(item({ id: 'x', type }), ctx, null);
        expect(valueAt(patch, '/fields/System.State')).toBeUndefined();
      }
    });
  });

  it('adds a Hierarchy-Reverse parent link when a parent url is given', () => {
    const ops = buildCreatePatch(
      item({ id: 'f', type: BacklogItemType.Feature }),
      ctx,
      'http://p/1',
    );
    const rel = ops.find((o) => o.path === '/relations/-');
    expect(rel).toBeDefined();
    expect((rel!.value as { rel: string }).rel).toBe('System.LinkTypes.Hierarchy-Reverse');
    expect((rel!.value as { url: string }).url).toBe('http://p/1');
  });

  it('clamps priority into the ADO 1–4 range', () => {
    const ops = buildCreatePatch(
      item({ id: 'x', type: BacklogItemType.Task, priority: 99 }),
      ctx,
      null,
    );
    expect(valueAt(ops, '/fields/Microsoft.VSTS.Common.Priority')).toBe(4);
  });
});

describe('orderParentsFirst', () => {
  it('orders every item after its parent', () => {
    const items = [
      item({ id: 't', type: BacklogItemType.Task, parentId: 's' }),
      item({ id: 'e', type: BacklogItemType.Epic }),
      item({ id: 's', type: BacklogItemType.Story, parentId: 'f' }),
      item({ id: 'f', type: BacklogItemType.Feature, parentId: 'e' }),
    ];
    const ordered = orderParentsFirst(items).map((i) => i.id);
    expect(ordered.indexOf('e')).toBeLessThan(ordered.indexOf('f'));
    expect(ordered.indexOf('f')).toBeLessThan(ordered.indexOf('s'));
    expect(ordered.indexOf('s')).toBeLessThan(ordered.indexOf('t'));
  });
});

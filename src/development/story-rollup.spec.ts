import { AdoWorkItem } from '../ado/ado.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { ProjectsService } from '../projects/projects.service';
import { StoryChild, decideStoryCompletion, decideStoryStart } from './story-rollup';
import { StoryRollupService } from './story-rollup.service';
import { adoStub } from '../testing/ado-stub';

const task = (id: number, state: string): StoryChild => ({ id, type: 'Task', state });
const bug = (id: number, state: string): StoryChild => ({ id, type: 'Bug', state });

/** The decision is the whole feature, so it is tested as a pure function first. */
describe('decideStoryCompletion', () => {
  it('promotes a Story whose every Task is Done', () => {
    expect(decideStoryCompletion('Committed', [task(1, 'Done'), task(2, 'Done')])).toEqual({
      promote: true,
      to: 'Done',
    });
  });

  it('holds while any Task is outstanding', () => {
    expect(decideStoryCompletion('Committed', [task(1, 'Done'), task(2, 'To Do')])).toEqual({
      promote: false,
      reason: 'tasks-outstanding',
    });
  });

  /**
   * The guard that stops the rollup fighting QA: a failed QA reopens the Story to Committed and
   * files a Bug. Without this, the next Task completion would shove it straight back to Done with
   * the defect still open.
   */
  it('refuses to complete a Story that still has an open Bug', () => {
    expect(decideStoryCompletion('Committed', [task(1, 'Done'), bug(9, 'Committed')])).toEqual({
      promote: false,
      reason: 'open-bugs',
    });
  });

  it('completes once the Bug is Done too', () => {
    expect(decideStoryCompletion('Committed', [task(1, 'Done'), bug(9, 'Done')])).toEqual({
      promote: true,
      to: 'Done',
    });
  });

  /** "All zero Tasks are Done" is not evidence that anything was built. */
  it('never promotes a Story with no Tasks', () => {
    expect(decideStoryCompletion('Committed', [])).toEqual({ promote: false, reason: 'no-tasks' });
    expect(decideStoryCompletion('Committed', [bug(9, 'Done')])).toEqual({
      promote: false,
      reason: 'no-tasks',
    });
  });

  it('is a no-op for a Story that is already Done', () => {
    expect(decideStoryCompletion('Done', [task(1, 'Done')])).toEqual({
      promote: false,
      reason: 'already-done',
    });
  });

  it('ignores case and padding in states and types', () => {
    expect(
      decideStoryCompletion('committed', [{ id: 1, type: ' task ', state: ' done ' }]),
    ).toEqual({ promote: true, to: 'Done' });
  });

  it('promotes from Approved too (a Story whose Tasks finished without a Committed step)', () => {
    expect(decideStoryCompletion('Approved', [task(1, 'Done')])).toEqual({
      promote: true,
      to: 'Done',
    });
  });
});

describe('decideStoryStart', () => {
  it.each(['New', 'Approved'])('moves a %s Story to Committed', (state) => {
    expect(decideStoryStart(state)).toEqual({ promote: true, to: 'Committed' });
  });

  it.each(['Committed', 'Done'])('leaves a %s Story alone', (state) => {
    expect(decideStoryStart(state)).toEqual({ promote: false, reason: 'not-promotable' });
  });
});

describe('StoryRollupService', () => {
  const projectId = '6aaa363961610d4d4107c5cf';
  const STORY_ID = 19549;
  const TASK_ID = 19565;

  let ado: {
    getWorkItemsBatch: jest.Mock;
    queryWorkItemIds: jest.Mock;
    setWorkItemState: jest.Mock;
    getWorkItemRelations: jest.Mock;
  };
  let projects: { findById: jest.Mock };
  let audit: { append: jest.Mock };
  let service: StoryRollupService;

  const item = (id: number, type: string, state: string, parent?: number): AdoWorkItem =>
    ({
      id,
      url: '',
      fields: {
        'System.WorkItemType': type,
        'System.State': state,
        ...(parent === undefined ? {} : { 'System.Parent': parent }),
      },
    }) as AdoWorkItem;

  /** Batch reads are keyed by id, so the mock answers from one work-item table. */
  const world = (items: AdoWorkItem[]) =>
    jest.fn().mockImplementation((ids: number[]) => items.filter((wi) => ids.includes(wi.id)));

  beforeEach(() => {
    ado = {
      getWorkItemsBatch: world([
        item(TASK_ID, 'Task', 'Done', STORY_ID),
        item(STORY_ID, 'Product Backlog Item', 'Committed'),
      ]),
      queryWorkItemIds: jest.fn().mockResolvedValue([TASK_ID]),
      setWorkItemState: jest.fn().mockResolvedValue({}),
      // No links by default: the ordinary case is a Task with a real parent field, where the
      // relation lookup is never needed.
      getWorkItemRelations: jest.fn().mockResolvedValue([]),
    };
    projects = {
      findById: jest.fn().mockResolvedValue({ adoTarget: { project: 'NQAI-DevAutomation' } }),
    };
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    service = new StoryRollupService(
      adoStub(ado),
      projects as unknown as ProjectsService,
      audit as unknown as AuditService,
    );
  });

  /**
   * The loop that silently broke for four Bugs.
   *
   * QA was told to link a Bug to its Story "(parent/related)" and chose **related** — which it had
   * been allowed to do. `System.Parent` was then empty, the Story was never found, and the fix was
   * never re-tested: Story 740 sat in `Committed` with its Bug Done, waiting for a request nothing
   * would make.
   */
  describe('a Bug linked to its Story the other way', () => {
    const BUG_ID = 19580;
    const url = (id: number) => `https://dev.azure.com/org/P/_apis/wit/workItems/${id}`;

    beforeEach(() => {
      // Story 740's real shape: one Task, Done, plus a Bug linked the other way.
      ado.getWorkItemsBatch = world([
        // No `System.Parent` — this is exactly the shape Bugs 814, 816, 825 and 858 have.
        item(BUG_ID, 'Bug', 'Done'),
        item(TASK_ID, 'Task', 'Done', STORY_ID),
        item(STORY_ID, 'Product Backlog Item', 'Committed'),
      ]);
      ado.queryWorkItemIds.mockResolvedValue([TASK_ID]);
      ado.getWorkItemRelations.mockImplementation((ids: number[]) =>
        Promise.resolve(
          ids[0] === BUG_ID
            ? [{ id: BUG_ID, relations: [{ rel: 'System.LinkTypes.Related', url: url(STORY_ID) }] }]
            : [
                {
                  id: STORY_ID,
                  relations: [{ rel: 'System.LinkTypes.Related', url: url(BUG_ID) }],
                },
              ],
        ),
      );
    });

    it('finds the Story through the related link and sends it back for re-test', async () => {
      await service.onTaskCompleted(projectId, BUG_ID);
      expect(ado.setWorkItemState).toHaveBeenCalledWith(
        STORY_ID,
        'Done',
        expect.stringContaining('Ready for QA'),
        expect.any(Object),
      );
    });

    /** An open Bug linked that way must still hold the Story back. */
    it('does not declare the Story ready while a related Bug is open', async () => {
      ado.getWorkItemsBatch = world([
        item(BUG_ID, 'Bug', 'New'),
        item(TASK_ID, 'Task', 'Done', STORY_ID),
        item(STORY_ID, 'Product Backlog Item', 'Committed'),
      ]);
      await service.onTaskCompleted(projectId, BUG_ID);
      expect(ado.setWorkItemState).not.toHaveBeenCalled();
    });
  });

  it('moves the Story to Done and audits it as Ready for QA', async () => {
    await service.onTaskCompleted(projectId, TASK_ID);
    expect(ado.setWorkItemState).toHaveBeenCalledWith(
      STORY_ID,
      'Done',
      expect.stringContaining('Ready for QA'),
      expect.any(Object),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.StoryReadyForQa,
        entityType: 'story',
        entityId: String(STORY_ID),
        metadata: expect.objectContaining({
          from: 'Committed',
          to: 'Done',
          triggeredByTask: TASK_ID,
        }),
      }),
    );
  });

  it('leaves the Story alone while a sibling Task is unfinished', async () => {
    ado.queryWorkItemIds.mockResolvedValue([TASK_ID, 19566]);
    ado.getWorkItemsBatch = world([
      item(TASK_ID, 'Task', 'Done', STORY_ID),
      item(19566, 'Task', 'To Do', STORY_ID),
      item(STORY_ID, 'Product Backlog Item', 'Committed'),
    ]);
    await service.onTaskCompleted(projectId, TASK_ID);
    expect(ado.setWorkItemState).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('does not re-complete a Story that QA reopened over an open Bug', async () => {
    ado.queryWorkItemIds.mockResolvedValue([TASK_ID, 90001]);
    ado.getWorkItemsBatch = world([
      item(TASK_ID, 'Task', 'Done', STORY_ID),
      item(90001, 'Bug', 'Committed', STORY_ID),
      item(STORY_ID, 'Product Backlog Item', 'Committed'),
    ]);
    await service.onTaskCompleted(projectId, TASK_ID);
    expect(ado.setWorkItemState).not.toHaveBeenCalled();
  });

  it('ignores a Task with no parent Story', async () => {
    ado.getWorkItemsBatch = world([item(TASK_ID, 'Task', 'Done')]);
    await service.onTaskCompleted(projectId, TASK_ID);
    expect(ado.setWorkItemState).not.toHaveBeenCalled();
  });

  it('moves an Approved Story to Committed when its first Task starts', async () => {
    ado.getWorkItemsBatch = world([
      item(TASK_ID, 'Task', 'In Progress', STORY_ID),
      item(STORY_ID, 'Product Backlog Item', 'Approved'),
    ]);
    await service.onTaskStarted(projectId, TASK_ID);
    expect(ado.setWorkItemState).toHaveBeenCalledWith(
      STORY_ID,
      'Committed',
      expect.any(String),
      expect.any(Object),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.StoryDevelopmentStarted }),
    );
  });

  /** Reopening for development invalidates a previous QA pass, so the tag must not survive it. */
  it('clears the qa-verified tag when development reopens the Story', async () => {
    ado.getWorkItemsBatch = world([
      item(TASK_ID, 'Task', 'In Progress', STORY_ID),
      {
        id: STORY_ID,
        url: '',
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Approved',
          'System.Tags': 'Phase3; qa-verified; ui',
        },
      } as AdoWorkItem,
    ]);
    await service.onTaskStarted(projectId, TASK_ID);
    expect(ado.setWorkItemState).toHaveBeenCalledWith(
      STORY_ID,
      'Committed',
      expect.any(String),
      expect.objectContaining({ 'System.Tags': 'Phase3; ui' }),
    );
  });

  it('leaves tags untouched when the Story was never QA-verified', async () => {
    ado.getWorkItemsBatch = world([
      item(TASK_ID, 'Task', 'In Progress', STORY_ID),
      {
        id: STORY_ID,
        url: '',
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Approved',
          'System.Tags': 'Phase3',
        },
      } as AdoWorkItem,
    ]);
    await service.onTaskStarted(projectId, TASK_ID);
    const fields = ado.setWorkItemState.mock.calls[0][3];
    expect(fields['System.Tags']).toBeUndefined();
  });

  it('does not pull a Done Story backwards when a Task starts', async () => {
    ado.getWorkItemsBatch = world([
      item(TASK_ID, 'Task', 'In Progress', STORY_ID),
      item(STORY_ID, 'Product Backlog Item', 'Done'),
    ]);
    await service.onTaskStarted(projectId, TASK_ID);
    expect(ado.setWorkItemState).not.toHaveBeenCalled();
  });

  /** The Task transition already succeeded; a rollup failure must never undo or surface into it. */
  /**
   * Scrum here makes Assigned To required to leave Approved, and ADO rejects the state change
   * (TF401320) unless the field is in the **same** patch — the same rule that bites Tasks.
   */
  describe('the Assigned To process rule', () => {
    const unassigned = () =>
      world([
        item(TASK_ID, 'Task', 'Done', STORY_ID),
        item(STORY_ID, 'Product Backlog Item', 'Approved'),
      ]);

    afterEach(() => {
      delete process.env.ADO_DEVELOPER_ASSIGNEE;
    });

    it('assigns the configured identity when the Story has none', async () => {
      process.env.ADO_DEVELOPER_ASSIGNEE = 'dev@example.com';
      ado.getWorkItemsBatch = unassigned();
      await service.onTaskCompleted(projectId, TASK_ID);
      expect(ado.setWorkItemState).toHaveBeenCalledWith(STORY_ID, 'Done', expect.any(String), {
        'System.AssignedTo': 'dev@example.com',
      });
    });

    it('never overwrites an assignee the Story already has', async () => {
      process.env.ADO_DEVELOPER_ASSIGNEE = 'dev@example.com';
      ado.getWorkItemsBatch = world([
        item(TASK_ID, 'Task', 'Done', STORY_ID),
        {
          id: STORY_ID,
          url: '',
          fields: {
            'System.WorkItemType': 'Product Backlog Item',
            'System.State': 'Approved',
            'System.AssignedTo': { uniqueName: 'someone@example.com' },
          },
        } as AdoWorkItem,
      ]);
      await service.onTaskCompleted(projectId, TASK_ID);
      expect(ado.setWorkItemState).toHaveBeenCalledWith(STORY_ID, 'Done', expect.any(String), {});
    });

    it('sends no extra fields when no identity is configured', async () => {
      ado.getWorkItemsBatch = unassigned();
      await service.onTaskCompleted(projectId, TASK_ID);
      expect(ado.setWorkItemState).toHaveBeenCalledWith(STORY_ID, 'Done', expect.any(String), {});
    });
  });

  it('never throws when Azure DevOps rejects the Story write', async () => {
    ado.setWorkItemState.mockRejectedValue(new Error('TF401320: rule error'));
    await expect(service.onTaskCompleted(projectId, TASK_ID)).resolves.toBeUndefined();
  });

  it('never throws when the work-item read fails', async () => {
    ado.getWorkItemsBatch = jest.fn().mockRejectedValue(new Error('ADO unavailable'));
    await expect(service.onTaskCompleted(projectId, TASK_ID)).resolves.toBeUndefined();
  });

  it('queries children in the project’s own ADO project', async () => {
    await service.onTaskCompleted(projectId, TASK_ID);
    expect(ado.queryWorkItemIds).toHaveBeenCalledWith(
      'NQAI-DevAutomation',
      expect.stringContaining(`[System.Parent] = ${STORY_ID}`),
    );
  });
});

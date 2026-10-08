import { BadRequestException } from '@nestjs/common';
import { Model } from 'mongoose';
import { TaskTransitionService } from './task-transition.service';
import { DevelopmentService } from './development.service';
import { AdoPushService } from '../ado/ado-push.service';
import { SprintContext, SprintService, normalizeIterationPath } from '../ado/sprint.service';
import { AuditService } from '../audit/audit.service';
import { StoryRollupService } from './story-rollup.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { JobsService } from '../jobs/jobs.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { BacklogItem, BacklogItemType, DraftDocument } from '../planning/schemas/draft.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { adoStub } from '../testing/ado-stub';

/**
 * Service-level tests for the board transitions: the centralized rules are applied to live ADO
 * facts, bulk operations report **per-Task** results, `dryRun` previews without changing anything,
 * and `Done` is orchestrator-only. The rules themselves are pinned in `task-transition-rules.spec`.
 */
const user = { userId: 'u1', email: 'admin@example.com' } as unknown as AuthenticatedUser;
/** Must be a real ObjectId — the service resolves the draft by `new Types.ObjectId(projectId)`. */
const PROJECT_ID = '6aaa363961610d4d4107c5cf';

const projectWith = (targetRepos: string[]): ProjectDocument =>
  ({ targetRepos, adoTarget: { project: 'Proj' } }) as unknown as ProjectDocument;

const sprints = (
  entries: Record<string, 'past' | 'current' | 'future'>,
  current: string | null,
): SprintContext => ({
  currentSprint: current,
  frames: new Map(
    Object.entries(entries).map(([path, frame]) => [normalizeIterationPath(path), frame]),
  ),
});

/** A To Do Task work item with a parent Story (id 900). */
const task = (id: number, iteration: string, over: Record<string, unknown> = {}) => ({
  id,
  url: '',
  fields: {
    'System.Title': `Task ${id}`,
    'System.State': 'To Do',
    'System.WorkItemType': 'Task',
    'System.Parent': 900,
    'System.Tags': '',
    'System.IterationPath': iteration,
    ...over,
  },
});

const backlogItem = (over: Partial<BacklogItem> & Pick<BacklogItem, 'id' | 'type'>): BacklogItem =>
  ({ title: `item ${over.id}`, parentId: null, adoId: null, ...over }) as BacklogItem;

const draftOf = (backlog: BacklogItem[]): DraftDocument =>
  ({ backlog }) as unknown as DraftDocument;

describe('TaskTransitionService', () => {
  /**
   * Plans are read with `find().sort().exec()` now that a project may have several; `drafts()` sets
   * what the next read returns, and `draftsOnce()` queues one read at a time for the cases that
   * check the state before and after a push.
   */
  let draftModel: Model<DraftDocument> & { __exec: jest.Mock };
  let ado: { setWorkItemState: jest.Mock; getWorkItemsBatch: jest.Mock };
  let push: { pushItems: jest.Mock };
  let development: { startDevelopmentForTasks: jest.Mock };
  let projects: { findById: jest.Mock };
  let sprintService: { getContext: jest.Mock };
  let jobs: { findActiveForWorkItem: jest.Mock };
  let audit: { append: jest.Mock };
  /** Rollup has its own spec; here it only needs to be callable. */
  let storyRollup: { onTaskStarted: jest.Mock; onTaskCompleted: jest.Mock };
  let service: TaskTransitionService;

  const dispatchResult = (over: Record<string, unknown> = {}) => ({
    dispatched: [],
    skippedActive: [],
    ineligible: [],
    deferred: [],
    candidates: 0,
    ...over,
  });

  /** Tasks come from the multi-field read; the parent Story from the single-field read. */
  /**
   * Two different reads hit this stub: the work items being transitioned, and their parent Stories.
   * They are told apart by what is asked for — the item read always wants the work-item type — and
   * not by how many fields were requested, which broke the moment the parent read also needed tags.
   */
  const adoReturns = (
    items: ReturnType<typeof task>[],
    parentState = 'Committed',
    parentTags = '',
  ) => {
    ado.getWorkItemsBatch.mockImplementation(async (ids: number[], fields: string[]) =>
      fields.includes('System.WorkItemType')
        ? items.filter((i) => ids.includes(i.id))
        : [
            {
              id: 900,
              url: '',
              fields: { 'System.State': parentState, 'System.Tags': parentTags },
            },
          ],
    );
  };

  const originalAssignee = process.env.ADO_DEVELOPER_ASSIGNEE;
  afterAll(() => {
    process.env.ADO_DEVELOPER_ASSIGNEE = originalAssignee;
  });

  beforeEach(() => {
    // Isolated per test — some cases opt in to the "Assigned To is required" process rule.
    delete process.env.ADO_DEVELOPER_ASSIGNEE;
    const exec = jest.fn().mockResolvedValue([]);
    draftModel = {
      __exec: exec,
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ exec }) }),
    } as unknown as Model<DraftDocument> & { __exec: jest.Mock };
    ado = {
      setWorkItemState: jest.fn().mockResolvedValue({}),
      getWorkItemsBatch: jest.fn().mockResolvedValue([]),
    };
    push = { pushItems: jest.fn().mockResolvedValue({ created: 1, skipped: 0, items: [] }) };
    development = { startDevelopmentForTasks: jest.fn().mockResolvedValue(dispatchResult()) };
    projects = { findById: jest.fn().mockResolvedValue(projectWith(['repo-a'])) };
    sprintService = {
      getContext: jest
        .fn()
        .mockResolvedValue(
          sprints({ 'Proj\\Sprint 1': 'current', 'Proj\\Sprint 4': 'future' }, 'Sprint 1'),
        ),
    };
    jobs = { findActiveForWorkItem: jest.fn().mockResolvedValue(null) };
    audit = { append: jest.fn().mockResolvedValue(null) };
    storyRollup = {
      onTaskStarted: jest.fn().mockResolvedValue(undefined),
      onTaskCompleted: jest.fn().mockResolvedValue(undefined),
    };
    service = new TaskTransitionService(
      draftModel as unknown as Model<DraftDocument>,
      adoStub(ado),
      push as unknown as AdoPushService,
      development as unknown as DevelopmentService,
      projects as unknown as ProjectsService,
      sprintService as unknown as SprintService,
      jobs as unknown as JobsService,
      audit as unknown as AuditService,
      storyRollup as unknown as StoryRollupService,
    );
  });

  it('rejects an empty selection', async () => {
    await expect(service.transition(PROJECT_ID, [], 'To Do', user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('Draft → To Do (approve)', () => {
    it('creates the Task in ADO and reports it as moved', async () => {
      draftModel.__exec
        .mockResolvedValueOnce([draftOf([backlogItem({ id: 't1', type: BacklogItemType.Task })])])
        .mockResolvedValueOnce([
          draftOf([backlogItem({ id: 't1', type: BacklogItemType.Task, adoId: 501 })]),
        ]);

      const result = await service.transition(PROJECT_ID, ['t1'], 'To Do', user);

      expect(push.pushItems).toHaveBeenCalledWith(PROJECT_ID, ['t1'], user);
      expect(result).toMatchObject({ to: 'To Do', requested: 1, succeeded: 1 });
      expect(result.outcomes[0]).toMatchObject({ adoId: 501, status: 'succeeded' });
    });

    it('blocks an item that is already in Azure DevOps', async () => {
      draftModel.__exec.mockResolvedValue([
        draftOf([backlogItem({ id: 't1', type: BacklogItemType.Task, adoId: 77 })]),
      ]);
      const result = await service.transition(PROJECT_ID, ['t1'], 'To Do', user);
      expect(push.pushItems).not.toHaveBeenCalled();
      expect(result.blocked).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/already in azure devops/i);
    });

    it('blocks a non-Task backlog item', async () => {
      draftModel.__exec.mockResolvedValue([
        draftOf([backlogItem({ id: 's1', type: BacklogItemType.Story })]),
      ]);
      const result = await service.transition(PROJECT_ID, ['s1'], 'To Do', user);
      expect(result.blocked).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/only tasks/i);
    });

    it('marks a Task failed when the push threw', async () => {
      draftModel.__exec.mockResolvedValue([
        draftOf([backlogItem({ id: 't1', type: BacklogItemType.Task })]),
      ]);
      push.pushItems.mockRejectedValue(new Error('ADO rejected the create'));
      const result = await service.transition(PROJECT_ID, ['t1'], 'To Do', user);
      expect(result.failed).toBe(1);
      expect(result.outcomes[0].reason).toContain('ADO rejected the create');
    });
  });

  describe('To Do → In Progress (dispatch)', () => {
    it('dispatches an eligible current-sprint Task and writes the ADO state', async () => {
      adoReturns([task(101, 'Proj\\Sprint 1')]);
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-9', workItemId: '101' }] }),
      );

      const result = await service.transition(PROJECT_ID, ['101'], 'In Progress', user);

      expect(development.startDevelopmentForTasks).toHaveBeenCalledWith(PROJECT_ID, ['101']);
      expect(ado.setWorkItemState).toHaveBeenCalledWith(
        101,
        'In Progress',
        expect.stringContaining('run-9'),
        expect.any(Object),
      );
      expect(result).toMatchObject({ succeeded: 1, blocked: 0 });
      expect(result.outcomes[0]).toMatchObject({ runId: 'run-9', status: 'succeeded' });
    });

    /**
     * A Bug runs `New → Committed → Done`; writing the Task word `In Progress` to one is rejected by
     * Azure DevOps outright ("not in the list of supported values"). Hit live on Bug 19614: the
     * agent ran but the Bug never left `New`, because the type was missing from the context read.
     */
    it('writes the Bug state vocabulary when dispatching a Bug, not the Task one', async () => {
      adoReturns([
        task(19614, 'Proj\Sprint 1', { 'System.WorkItemType': 'Bug', 'System.State': 'New' }),
      ]);
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-bug', workItemId: '19614' }] }),
      );

      const result = await service.transition(PROJECT_ID, ['19614'], 'In Progress', user);

      expect(ado.setWorkItemState).toHaveBeenCalledWith(
        19614,
        'Committed',
        expect.stringContaining('run-bug'),
        expect.any(Object),
      );
      expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', reason: undefined });
    });

    /**
     * The regression that caused the above: the context read never asked for the work-item type, so
     * every item defaulted to `Task`. The fixture returns every field regardless of what is
     * requested, so only asserting on the *request* catches it.
     */
    it('asks Azure DevOps for the work-item type when building the start context', async () => {
      adoReturns([task(101, 'Proj\Sprint 1')]);
      development.startDevelopmentForTasks.mockResolvedValue(dispatchResult());

      await service.transition(PROJECT_ID, ['101'], 'In Progress', user);

      const requestedFields = ado.getWorkItemsBatch.mock.calls
        .map((call) => call[1] as string[])
        .find((fields) => fields.length > 1);
      expect(requestedFields).toContain('System.WorkItemType');
    });

    it('blocks a future-sprint Task and never dispatches it', async () => {
      adoReturns([task(102, 'Proj\\Sprint 4')]);

      const result = await service.transition(PROJECT_ID, ['102'], 'In Progress', user);

      expect(development.startDevelopmentForTasks).not.toHaveBeenCalled();
      expect(result.blocked).toBe(1);
      expect(result.outcomes[0].reason).toContain('Sprint 4');
      expect(result.outcomes[0].reason).toContain('Sprint 1');
    });

    it('blocks a Task with no resolvable execution agent', async () => {
      projects.findById.mockResolvedValue(projectWith(['repo-a', 'repo-b'])); // ambiguous, no tag
      adoReturns([task(103, 'Proj\\Sprint 1')]);

      const result = await service.transition(PROJECT_ID, ['103'], 'In Progress', user);

      expect(result.blocked).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/no execution agent/i);
    });

    /**
     * The repository is inherited from the parent Story when the item carries no tag of its own.
     *
     * QA files Bugs through the Azure DevOps MCP and tags them with the repo — but only most of the
     * time. Four of seventeen real Bugs arrived untagged, and on a two-repository project that
     * resolves to no execution agent, so "Fix with Developer Agent" was refused for every one of
     * them. The first fix went into the board projection, which is what the card *displays*; this
     * is the path that actually decides, and it is the one the dialog reads.
     */
    it('inherits the repo from the parent Story when the item has no tag', async () => {
      projects.findById.mockResolvedValue(projectWith(['repo-a', 'repo-b'])); // ambiguous on its own
      adoReturns([task(106, 'Proj\Sprint 1')], 'Committed', 'repo:repo-a');
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-11', workItemId: '106' }] }),
      );

      const result = await service.transition(PROJECT_ID, ['106'], 'In Progress', user);

      expect(result.blocked).toBe(0);
      expect(development.startDevelopmentForTasks).toHaveBeenCalled();
    });

    /** Nothing above it knows either, so "no execution agent" remains the honest answer. */
    it('still blocks when neither the item nor its parent names a repo', async () => {
      projects.findById.mockResolvedValue(projectWith(['repo-a', 'repo-b']));
      adoReturns([task(107, 'Proj\Sprint 1')], 'Committed', '');

      const result = await service.transition(PROJECT_ID, ['107'], 'In Progress', user);

      expect(result.blocked).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/no execution agent/i);
    });

    it('skips a Task that already has an active execution', async () => {
      adoReturns([task(104, 'Proj\\Sprint 1')]);
      jobs.findActiveForWorkItem.mockResolvedValue({ runId: 'run-live' });

      const result = await service.transition(PROJECT_ID, ['104'], 'In Progress', user);

      expect(development.startDevelopmentForTasks).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/already has an active/i);
    });

    it('blocks when the parent Story is not approved', async () => {
      adoReturns([task(105, 'Proj\\Sprint 1')], 'New');
      const result = await service.transition(PROJECT_ID, ['105'], 'In Progress', user);
      expect(result.blocked).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/parent story is not approved/i);
    });

    it('validates each Task independently in a bulk selection', async () => {
      adoReturns([task(101, 'Proj\\Sprint 1'), task(102, 'Proj\\Sprint 4')]);
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-9', workItemId: '101' }] }),
      );

      const result = await service.transition(PROJECT_ID, ['101', '102'], 'In Progress', user);

      // Only the eligible Task reaches dispatch; the blocked one keeps its state.
      expect(development.startDevelopmentForTasks).toHaveBeenCalledWith(PROJECT_ID, ['101']);
      expect(result).toMatchObject({ requested: 2, succeeded: 1, blocked: 1 });
    });

    it('still counts a dispatch as success when the ADO state write fails, with a caveat', async () => {
      adoReturns([task(101, 'Proj\\Sprint 1')]);
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-9', workItemId: '101' }] }),
      );
      ado.setWorkItemState.mockRejectedValue(new Error('409 conflict'));

      const result = await service.transition(PROJECT_ID, ['101'], 'In Progress', user);
      expect(result.succeeded).toBe(1);
      expect(result.outcomes[0].reason).toContain('409 conflict');
    });

    it('fills Assigned To when the Task has none (the process requires it to leave To Do)', async () => {
      process.env.ADO_DEVELOPER_ASSIGNEE = 'dev@x.io';
      adoReturns([task(101, 'Proj\Sprint 1')]); // no System.AssignedTo
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-9', workItemId: '101' }] }),
      );

      await service.transition(PROJECT_ID, ['101'], 'In Progress', user);

      expect(ado.setWorkItemState).toHaveBeenCalledWith(101, 'In Progress', expect.any(String), {
        'System.AssignedTo': 'dev@x.io',
      });
    });

    it('never overwrites an assignee the Task already has', async () => {
      process.env.ADO_DEVELOPER_ASSIGNEE = 'dev@x.io';
      adoReturns([
        task(101, 'Proj\Sprint 1', { 'System.AssignedTo': { uniqueName: 'someone@else.io' } }),
      ]);
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-9', workItemId: '101' }] }),
      );

      await service.transition(PROJECT_ID, ['101'], 'In Progress', user);

      expect(ado.setWorkItemState).toHaveBeenCalledWith(101, 'In Progress', expect.any(String), {});
    });

    it('reports a capped dispatch as skipped, not lost', async () => {
      adoReturns([task(101, 'Proj\\Sprint 1')]);
      development.startDevelopmentForTasks.mockResolvedValue(dispatchResult({ deferred: ['101'] }));
      const result = await service.transition(PROJECT_ID, ['101'], 'In Progress', user);
      expect(result.skipped).toBe(1);
      expect(result.outcomes[0].reason).toMatch(/cap/i);
    });
  });

  describe('dryRun (bulk confirmation preview)', () => {
    it('reports eligibility without dispatching, writing or auditing', async () => {
      adoReturns([task(101, 'Proj\\Sprint 1'), task(102, 'Proj\\Sprint 4')]);

      const preview = await service.transition(PROJECT_ID, ['101', '102'], 'In Progress', user, {
        dryRun: true,
      });

      expect(preview.dryRun).toBe(true);
      expect(preview).toMatchObject({ succeeded: 1, blocked: 1 });
      expect(development.startDevelopmentForTasks).not.toHaveBeenCalled();
      expect(ado.setWorkItemState).not.toHaveBeenCalled();
      expect(audit.append).not.toHaveBeenCalled();
    });
  });

  describe('audit trail', () => {
    it('records actor, source, bulk id, counts and per-Task results', async () => {
      adoReturns([task(101, 'Proj\\Sprint 1'), task(102, 'Proj\\Sprint 4')]);
      development.startDevelopmentForTasks.mockResolvedValue(
        dispatchResult({ dispatched: [{ runId: 'run-9', workItemId: '101' }] }),
      );

      const result = await service.transition(PROJECT_ID, ['101', '102'], 'In Progress', user, {
        source: 'drag-drop',
      });

      const entry = audit.append.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.TaskDevelopmentStarted);
      expect(entry.actor.actorEmail).toBe('admin@example.com');
      expect(entry.metadata).toMatchObject({
        source: 'drag-drop',
        bulkOperationId: result.bulkOperationId,
        from: 'To Do',
        to: 'In Progress',
        totalSelected: 2,
        succeeded: 1,
        blocked: 1,
      });
      expect(entry.metadata.tasks).toHaveLength(2);
    });
  });

  describe('orchestrator-owned completion', () => {
    it('moves the Task to Done and audits it as a system action', async () => {
      await service.completeTask(PROJECT_ID, '101', 'run-9');
      expect(ado.setWorkItemState).toHaveBeenCalledWith(
        101,
        'Done',
        expect.stringContaining('run-9'),
        expect.any(Object),
      );
      const entry = audit.append.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.TaskCompleted);
      expect(entry.actor.actorEmail).toBe('system');
    });

    it('audits a completion failure instead of throwing into run ingest', async () => {
      ado.setWorkItemState.mockRejectedValue(new Error('ADO down'));
      await expect(service.completeTask(PROJECT_ID, '101', 'run-9')).resolves.toBeUndefined();
      expect(audit.append.mock.calls[0][0].metadata).toMatchObject({ result: 'failed' });
    });

    it('records a failed run without ever moving the Task to Done', async () => {
      await service.recordExecutionFailure(PROJECT_ID, '101', 'run-9', 'build failed');
      const entry = audit.append.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.TaskExecutionFailed);
      expect(entry.metadata).toMatchObject({ result: 'failed' });
      expect(ado.setWorkItemState).not.toHaveBeenCalledWith(
        expect.anything(),
        'Done',
        expect.anything(),
        expect.anything(),
      );
    });

    /**
     * A failed Task must come back out of In Progress.
     *
     * Leaving it there was deliberate — "the retry machinery owns recovery" — but no such
     * machinery exists for a run that genuinely failed, and `startDevelopment` refuses to start a
     * Task that is not in To Do. So the Task was stuck: not done, not retryable, and showing
     * In Progress on the board hours after the pod had gone.
     */
    it('returns a failed Task to To Do so it can be retried', async () => {
      await service.recordExecutionFailure(PROJECT_ID, '101', 'run-9', 'build failed');
      expect(ado.setWorkItemState).toHaveBeenCalledWith(
        101,
        'To Do',
        expect.stringContaining('run-9'),
        expect.any(Object),
      );
      expect(audit.append.mock.calls[0][0].metadata).toMatchObject({
        from: 'In Progress',
        to: 'To Do',
      });
    });

    it('names the failure on the work item so the board says why', async () => {
      await service.recordExecutionFailure(PROJECT_ID, '101', 'run-9', 'build failed');
      expect(ado.setWorkItemState.mock.calls[0][2]).toContain('build failed');
    });

    /** ADO being unreachable must not break run ingest, and must not claim the Task moved. */
    it('still audits the failure when the Task cannot be returned', async () => {
      ado.setWorkItemState.mockRejectedValue(new Error('ADO down'));
      await expect(
        service.recordExecutionFailure(PROJECT_ID, '101', 'run-9', 'build failed'),
      ).resolves.toBeUndefined();
      const entry = audit.append.mock.calls[0][0];
      expect(entry.metadata).toMatchObject({ to: 'In Progress', result: 'failed' });
      expect(entry.metadata.reason).toContain('ADO down');
    });
  });
});

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';
import { DraftDocument } from '../planning/schemas/draft.schema';
import { AdoWorkItem } from '../ado/ado.types';
import { JobDispatchService } from '../jobs/job-dispatch.service';
import { JobsService } from '../jobs/jobs.service';
import { JobRole, JobState, PermissionMode } from '../jobs/job-state';
import { JobDocument } from '../jobs/schemas/job.schema';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { AppConfigService } from '../common/config/app-config.service';
import { DevelopmentService } from './development.service';
import { adoStub } from '../testing/ado-stub';

/** An eligible Task (To Do) whose parent Story (999) is Approved — the happy path for dispatch. */
const eligibleAdo = (name: string, ids: number[]): AdoWorkItem[] => {
  void name;
  if (ids[0] === 999) {
    return [{ id: 999, url: '', fields: { 'System.State': 'Approved' } }];
  }
  return [
    {
      id: ids[0],
      url: '',
      fields: {
        'System.WorkItemType': 'Task',
        'System.State': 'To Do',
        'System.Parent': 999,
      },
    },
  ];
};

/**
 * Unit tests for the Developer dispatch: eligibility (composeJobSpec) and the dispatch side effects
 * (enqueue → dispatch), including the never-hard-fail behaviour when the execution backend is
 * unreachable. Collaborators are mocked; the one-active-run guard is exercised against real Mongo in
 * jobs.service.spec, and token/context assembly in job-dispatch.service.spec.
 */
describe('DevelopmentService', () => {
  const project = {
    id: '507f1f77bcf86cd799439011',
    targetRepos: ['NQAI-DevAutomation'],
    adoTarget: {
      orgUrl: 'https://dev.azure.com/g7crtipl',
      project: 'NQAI-DevAutomation',
      areaPath: 'NQAI-DevAutomation\\Agentic SDLC Orchestrator',
    },
  } as unknown as ProjectDocument;

  let projects: { findById: jest.Mock };
  let jobs: { enqueue: jest.Mock; findActiveForWorkItem: jest.Mock; countActive: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let ado: { getWorkItemsBatch: jest.Mock; queryWorkItemIds: jest.Mock };
  let service: DevelopmentService;

  const makeJob = (over: Partial<JobDocument> = {}): JobDocument =>
    ({ runId: 'run-x', role: JobRole.Developer, state: JobState.Queued, ...over }) as JobDocument;

  beforeEach(() => {
    projects = { findById: jest.fn().mockResolvedValue(project) };
    jobs = {
      enqueue: jest
        .fn()
        .mockImplementation((spec: { runId: string }) =>
          Promise.resolve(makeJob({ runId: spec.runId })),
        ),
      findActiveForWorkItem: jest.fn().mockResolvedValue(null),
      countActive: jest.fn().mockResolvedValue(0),
    };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    ado = {
      getWorkItemsBatch: jest.fn().mockImplementation((ids: number[]) => eligibleAdo('', ids)),
      queryWorkItemIds: jest.fn().mockResolvedValue([]),
    };
    const config = { maxConcurrentRuns: 5 } as AppConfigService;
    // No drafts: these tests are about the Azure DevOps rules, and a work item that belongs to no
    // plan has no dependencies to wait on — which is what a Bug filed by QA looks like too.
    const drafts = { find: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }) };
    service = new DevelopmentService(
      projects as unknown as ProjectsService,
      jobs as unknown as JobsService,
      dispatcher as unknown as JobDispatchService,
      adoStub(ado),
      config,
      drafts as unknown as Model<DraftDocument>,
    );
  });

  describe('composeJobSpec', () => {
    it('builds a developer/bypass job spec for an eligible request', () => {
      const spec = service.composeJobSpec(
        project,
        { workItemId: '18223', repo: 'NQAI-DevAutomation' },
        'run-1',
      );
      expect(spec).toMatchObject({
        runId: 'run-1',
        role: JobRole.Developer,
        projectId: project.id,
        workItemId: '18223',
        repo: 'NQAI-DevAutomation',
        permissionMode: PermissionMode.BypassPermissions,
      });
    });

    it('rejects a missing work item id', () => {
      expect(() => service.composeJobSpec(project, { workItemId: ' ', repo: 'r' }, 'r1')).toThrow(
        BadRequestException,
      );
    });

    it('rejects a repo not in the project allow-list', () => {
      expect(() =>
        service.composeJobSpec(project, { workItemId: '1', repo: 'other-repo' }, 'r1'),
      ).toThrow(BadRequestException);
    });

    it('allows any repo when the project declares no allow-list', () => {
      const open = { id: project.id, targetRepos: [] } as unknown as ProjectDocument;
      const spec = service.composeJobSpec(open, { workItemId: '1', repo: 'anything' }, 'r1');
      expect(spec.repo).toBe('anything');
    });
  });

  describe('startDevelopment', () => {
    it('enqueues then dispatches the pod', async () => {
      const job = await service.startDevelopment(project.id as string, {
        workItemId: '18223',
        repo: 'NQAI-DevAutomation',
      });
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ role: JobRole.Developer, workItemId: '18223' }),
      );
      expect(dispatcher.dispatch).toHaveBeenCalledWith(job);
    });

    it('does not hard-fail when the execution backend is unreachable (job stays Queued)', async () => {
      dispatcher.dispatch.mockRejectedValue(new Error('no cluster'));
      const job = await service.startDevelopment(project.id as string, {
        workItemId: '18223',
        repo: 'NQAI-DevAutomation',
      });
      expect(job.state).toBe(JobState.Queued);
    });

    it('propagates a 409 when an active run already exists for the work item', async () => {
      jobs.enqueue.mockRejectedValue(new ConflictException('active run exists'));
      await expect(
        service.startDevelopment(project.id as string, {
          workItemId: '18223',
          repo: 'NQAI-DevAutomation',
        }),
      ).rejects.toThrow(ConflictException);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('propagates a 404 for an unknown project', async () => {
      projects.findById.mockRejectedValue(new NotFoundException('no project'));
      await expect(
        service.startDevelopment('missing', { workItemId: '1', repo: 'r' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('eligibility validation (against Azure DevOps, before dispatch)', () => {
    const start = () =>
      service.startDevelopment(project.id as string, {
        workItemId: '18223',
        repo: 'NQAI-DevAutomation',
      });

    it('rejects a Task that does not exist in ADO', async () => {
      ado.getWorkItemsBatch.mockResolvedValue([]);
      await expect(start()).rejects.toThrow(BadRequestException);
      expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('rejects a work item that is neither a Task nor a Bug', async () => {
      ado.getWorkItemsBatch.mockResolvedValue([
        {
          id: 18223,
          url: '',
          fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.State': 'To Do' },
        },
      ]);
      await expect(start()).rejects.toThrow(/Tasks and Bugs only/);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    /**
     * A Developer agent also fixes QA-found defects (D-019). A Bug waits in `New`, not `To Do`, and
     * has no parent-Story approval gate — it is raised against work already under way.
     */
    it('accepts a Bug in New and dispatches a Developer pod for it', async () => {
      ado.getWorkItemsBatch.mockResolvedValue([
        { id: 18223, url: '', fields: { 'System.WorkItemType': 'Bug', 'System.State': 'New' } },
      ]);
      await start();
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: '18223', role: JobRole.Developer }),
      );
    });

    /**
     * A Bug QA reopened is dispatchable again.
     *
     * QA rejects a fix by moving the Bug back to `Committed`, not to `New`. Refusing that state
     * left Bug #628 sitting in the In Progress column for ten hours with no action available —
     * nothing was running, and nothing could be started. Whether a run is genuinely in flight is
     * the enqueue guard's question, not the state's.
     */
    it('accepts a Bug QA reopened to Committed', async () => {
      ado.getWorkItemsBatch.mockResolvedValue([
        {
          id: 18223,
          url: '',
          fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Committed' },
        },
      ]);
      await start();
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: '18223', role: JobRole.Developer }),
      );
    });

    /** `Done` means "fixed, awaiting retest" — dispatching again would undo QA's turn. */
    it('rejects a Bug that is already Done and awaiting retest', async () => {
      ado.getWorkItemsBatch.mockResolvedValue([
        { id: 18223, url: '', fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Done' } },
      ]);
      await expect(start()).rejects.toThrow(/not 'New' or 'Committed'/);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a Task that is not in To Do', async () => {
      ado.getWorkItemsBatch.mockResolvedValue([
        {
          id: 18223,
          url: '',
          fields: { 'System.WorkItemType': 'Task', 'System.State': 'Done', 'System.Parent': 999 },
        },
      ]);
      await expect(start()).rejects.toThrow(/not 'To Do'/);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a Task whose parent Story is not approved', async () => {
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) =>
        Promise.resolve(
          ids[0] === 999
            ? [{ id: 999, url: '', fields: { 'System.State': 'New' } }]
            : [
                {
                  id: ids[0],
                  url: '',
                  fields: {
                    'System.WorkItemType': 'Task',
                    'System.State': 'To Do',
                    'System.Parent': 999,
                  },
                },
              ],
        ),
      );
      await expect(start()).rejects.toThrow(/not approved/);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('dispatches when the Task is To Do and its parent Story is approved', async () => {
      await expect(start()).resolves.toBeDefined();
      expect(jobs.enqueue).toHaveBeenCalled();
      expect(dispatcher.dispatch).toHaveBeenCalled();
    });
  });

  describe('parseRepoTag / resolveRepo', () => {
    it('parses a repo:<name> tag from an ADO tag string', () => {
      expect(DevelopmentService.parseRepoTag('Phase2; repo:NQAI-DevAutomation')).toBe(
        'NQAI-DevAutomation',
      );
      expect(DevelopmentService.parseRepoTag('Phase2; other')).toBeNull();
    });

    it('resolves the tagged repo when allowed, else the sole target repo', () => {
      expect(DevelopmentService.resolveRepo(project, 'NQAI-DevAutomation')).toBe(
        'NQAI-DevAutomation',
      );
      // tag not in the allow-list → falls back to the single target repo
      expect(DevelopmentService.resolveRepo(project, 'other')).toBe('NQAI-DevAutomation');
      const multi = { targetRepos: ['a', 'b'] } as unknown as ProjectDocument;
      expect(DevelopmentService.resolveRepo(multi, null)).toBeUndefined();
    });
  });

  describe('startDevelopmentBatch', () => {
    it('fans out one pod per eligible To Do Task', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102, 103]);
      const result = await service.startDevelopmentBatch(project.id as string);
      expect(result.candidates).toBe(3);
      expect(result.dispatched).toHaveLength(3);
      expect(jobs.enqueue).toHaveBeenCalledTimes(3);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    });

    it('skips Tasks that already have an active run (idempotent re-trigger)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102]);
      jobs.findActiveForWorkItem.mockImplementation((wid: string) =>
        Promise.resolve(wid === '101' ? makeJob() : null),
      );
      const result = await service.startDevelopmentBatch(project.id as string);
      expect(result.skippedActive).toEqual(['101']);
      expect(result.dispatched).toHaveLength(1);
    });

    it('defers eligible Tasks beyond the concurrency budget (maxDispatch)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102, 103]);
      const result = await service.startDevelopmentBatch(project.id as string, { maxDispatch: 2 });
      expect(result.dispatched).toHaveLength(2);
      expect(result.deferred).toEqual(['103']);
    });

    it('caps the manual batch at MAX_CONCURRENT_RUNS minus active runs (no explicit budget)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102, 103, 104, 105, 106]);
      jobs.countActive.mockResolvedValue(3); // cap 5 - 3 active = budget 2
      const result = await service.startDevelopmentBatch(project.id as string);
      expect(result.dispatched).toHaveLength(2);
      expect(result.deferred).toEqual(['103', '104', '105', '106']);
    });

    it('dispatches nothing when already at the concurrency cap', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102]);
      jobs.countActive.mockResolvedValue(5); // at cap → budget 0
      const result = await service.startDevelopmentBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(result.deferred).toEqual(['101', '102']);
    });

    it('records ineligible Tasks with a reason instead of dispatching them', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102]);
      // 102 is a Story (never agent-executable); 101 eligible.
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) => {
        if (ids[0] === 102) {
          return Promise.resolve([
            {
              id: 102,
              url: '',
              fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.State': 'To Do' },
            },
          ]);
        }
        return Promise.resolve(eligibleAdo('', ids));
      });
      const result = await service.startDevelopmentBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
      expect(result.ineligible).toEqual([
        { workItemId: '102', reason: expect.stringMatching(/Tasks and Bugs only/) },
      ]);
    });

    it('treats a mid-loop 409 (raced into active) as skipped, not fatal', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101, 102]);
      jobs.enqueue
        .mockImplementationOnce((spec: { runId: string }) =>
          Promise.resolve(makeJob({ runId: spec.runId })),
        )
        .mockImplementationOnce(() => Promise.reject(new ConflictException('active')));
      const result = await service.startDevelopmentBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
      expect(result.skippedActive).toContain('102');
    });
  });

  /**
   * A new Task waits for the old Task it needs.
   *
   * An enhancement Task — "add a dark mode toggle to the Settings page" — is well-formed, approved
   * and correctly tagged while **Build the Settings page** is still in To Do. Without this gate it
   * is dispatched, the agent opens the code, finds no Settings page, and either fails or builds its
   * own beside the one the original plan was going to build.
   */
  describe('waiting for work it depends on', () => {
    /** The enhancement Task (101) depends on work item 790 from the original plan. */
    const draftWithDependency = (dependsOn: string[]) => ({
      backlog: [{ id: 'task-toggle', adoId: 101, dependsOn }],
    });

    const withDrafts = (drafts: unknown[]) => {
      (service as unknown as { draftModel: unknown }).draftModel = {
        find: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(drafts) }),
      };
    };

    /** 790 is the blocker; everything else answers as an eligible Task would. */
    const adoWith = (blockerState: string) =>
      jest.fn().mockImplementation((ids: number[]) => {
        if (ids[0] === 790) {
          return [
            {
              id: 790,
              url: '',
              fields: {
                'System.State': blockerState,
                'System.Title': 'Build the Settings page',
              },
            },
          ];
        }
        return eligibleAdo('', ids);
      });

    it('refuses while the work it depends on is unfinished, and says which', async () => {
      ado.getWorkItemsBatch = adoWith('To Do');
      withDrafts([draftWithDependency(['#790'])]);

      await expect(
        service.startDevelopment(project.id as string, {
          workItemId: '101',
          repo: 'NQAI-DevAutomation',
        }),
      ).rejects.toThrow(/#790/);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('starts it once the blocker is Done', async () => {
      ado.getWorkItemsBatch = adoWith('Done');
      withDrafts([draftWithDependency(['#790'])]);

      await service.startDevelopment(project.id as string, {
        workItemId: '101',
        repo: 'NQAI-DevAutomation',
      });
      expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ workItemId: '101' }));
    });

    /** Cancelled work never reaches Done; blocking on it would strand the Task for ever. */
    it('does not wait for a Removed blocker', async () => {
      ado.getWorkItemsBatch = adoWith('Removed');
      withDrafts([draftWithDependency(['#790'])]);

      await expect(
        service.startDevelopment(project.id as string, {
          workItemId: '101',
          repo: 'NQAI-DevAutomation',
        }),
      ).resolves.toBeDefined();
    });

    /** A work item belonging to no plan — a Bug filed by QA — has nothing to wait for. */
    it('does not hold up a work item that belongs to no plan', async () => {
      ado.getWorkItemsBatch = adoWith('To Do');
      withDrafts([]);

      await expect(
        service.startDevelopment(project.id as string, {
          workItemId: '101',
          repo: 'NQAI-DevAutomation',
        }),
      ).resolves.toBeDefined();
    });

    /** Development must not stop because a draft could not be read. */
    it('lets the Task through when the plan cannot be read', async () => {
      ado.getWorkItemsBatch = adoWith('To Do');
      (service as unknown as { draftModel: unknown }).draftModel = {
        find: jest.fn().mockReturnValue({
          exec: jest.fn().mockRejectedValue(new Error('mongo down')),
        }),
      };

      await expect(
        service.startDevelopment(project.id as string, {
          workItemId: '101',
          repo: 'NQAI-DevAutomation',
        }),
      ).resolves.toBeDefined();
    });
  });
});

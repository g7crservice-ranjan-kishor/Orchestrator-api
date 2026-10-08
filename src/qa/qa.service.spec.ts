import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdoWorkItem } from '../ado/ado.types';
import { JobDispatchService } from '../jobs/job-dispatch.service';
import { JobsService } from '../jobs/jobs.service';
import { JobRole, JobState, PermissionMode } from '../jobs/job-state';
import { JobDocument } from '../jobs/schemas/job.schema';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { AppConfigService } from '../common/config/app-config.service';
import { QaService } from './qa.service';
import { adoStub } from '../testing/ado-stub';

/** A Story (PBI) in Done and a Bug in Done are both Ready-for-QA; anything else is not. */
const readyForQaAdo = (ids: number[]): AdoWorkItem[] => {
  const id = ids[0];
  // Even ids model Stories, odd ids model Bugs — both Done (Ready for QA / awaiting retest).
  const type = id % 2 === 0 ? 'Product Backlog Item' : 'Bug';
  return [{ id, url: '', fields: { 'System.WorkItemType': type, 'System.State': 'Done' } }];
};

/**
 * Unit tests for the QA batch dispatch (ARCHITECTURE.md §4B, D-018): enumeration of Ready-for-QA
 * items (Stories in Done + Bugs awaiting retest), per-item eligibility against the **verified**
 * project state model, idempotency via the one-active-run guard, the concurrency budget, and the
 * never-hard-fail behaviour when the execution backend is unreachable. Collaborators are mocked; the
 * one-active-run guard is exercised against real Mongo in jobs.service.spec.
 */
describe('QaService', () => {
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
  let service: QaService;

  const makeJob = (over: Partial<JobDocument> = {}): JobDocument =>
    ({ runId: 'run-x', role: JobRole.QA, state: JobState.Queued, ...over }) as JobDocument;

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
      getWorkItemsBatch: jest.fn().mockImplementation((ids: number[]) => readyForQaAdo(ids)),
      queryWorkItemIds: jest.fn().mockResolvedValue([]),
    };
    const config = { maxConcurrentRuns: 5 } as AppConfigService;
    service = new QaService(
      projects as unknown as ProjectsService,
      jobs as unknown as JobsService,
      dispatcher as unknown as JobDispatchService,
      adoStub(ado),
      config,
    );
  });

  describe('composeJobSpec', () => {
    it('builds a qa/bypass job spec targeting the work item + repo', () => {
      const spec = service.composeJobSpec(project, '18100', 'NQAI-DevAutomation', 'run-1');
      expect(spec).toMatchObject({
        runId: 'run-1',
        role: JobRole.QA,
        projectId: project.id,
        workItemId: '18100',
        repo: 'NQAI-DevAutomation',
        permissionMode: PermissionMode.BypassPermissions,
      });
    });
  });

  describe('startQaBatch — enumeration & fan-out', () => {
    it('fans out one QA pod per Ready-for-QA item (Stories in Done + Bugs awaiting retest)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101, 102]); // story, bug, story
      const result = await service.startQaBatch(project.id as string);
      expect(result.candidates).toBe(3);
      expect(result.dispatched).toHaveLength(3);
      // The dispatch carries what the item *is*, so the UI can name it rather than show a bare id.
      expect(result.dispatched[0]).toEqual({
        runId: expect.any(String),
        workItemId: '100',
        title: expect.any(String),
        kind: 'story',
      });
      expect(jobs.enqueue).toHaveBeenCalledTimes(3);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
      expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ role: JobRole.QA }));
    });

    it('enumerates via a WIQL that targets Stories and Bugs in Done under the area path', async () => {
      ado.queryWorkItemIds.mockResolvedValue([]);
      await service.startQaBatch(project.id as string);
      const wiql = ado.queryWorkItemIds.mock.calls[0][1] as string;
      expect(wiql).toContain("[System.WorkItemType] IN ('Product Backlog Item', 'Bug')");
      expect(wiql).toContain("[System.State] = 'Done'");
      expect(wiql).toContain('UNDER');
    });

    it('returns nothing to dispatch when no items are Ready for QA (no auto-dispatch)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([]);
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('startQaBatch — idempotency', () => {
    it('skips items that already have an active run (re-clicking never double-dispatches)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101]);
      jobs.findActiveForWorkItem.mockImplementation((wid: string) =>
        Promise.resolve(wid === '100' ? makeJob() : null),
      );
      const result = await service.startQaBatch(project.id as string);
      expect(result.skippedActive).toEqual(['100']);
      expect(result.dispatched).toHaveLength(1);
    });

    it('treats a mid-loop 409 (raced into active) as skipped, not fatal', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101]);
      jobs.enqueue
        .mockImplementationOnce((spec: { runId: string }) =>
          Promise.resolve(makeJob({ runId: spec.runId })),
        )
        .mockImplementationOnce(() => Promise.reject(new ConflictException('active')));
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
      expect(result.skippedActive).toContain('101');
    });
  });

  describe('startQaBatch — capacity budget', () => {
    it('defers eligible items beyond the explicit budget (maxDispatch)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101, 102]);
      const result = await service.startQaBatch(project.id as string, { maxDispatch: 2 });
      expect(result.dispatched).toHaveLength(2);
      expect(result.deferred).toEqual(['102']);
    });

    it('caps the manual batch at MAX_CONCURRENT_RUNS minus active runs (no explicit budget)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101, 102, 103, 104, 105]);
      jobs.countActive.mockResolvedValue(3); // cap 5 - 3 active = budget 2
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(2);
      expect(result.deferred).toEqual(['102', '103', '104', '105']);
    });

    it('dispatches nothing when already at the concurrency cap', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101]);
      jobs.countActive.mockResolvedValue(5); // at cap → budget 0
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(result.deferred).toEqual(['100', '101']);
    });
  });

  /**
   * D-025: an awaiting-retest Bug and a verified Bug both live in `Done`, so without the tag every
   * wave would re-dispatch a pod for every Bug ever verified and the QA leg would never converge.
   */
  describe('startQaBatch — verified-Bug de-duplication (D-025)', () => {
    const withTags = (id: number, type: string, tags: string): AdoWorkItem[] => [
      {
        id,
        url: '',
        fields: { 'System.WorkItemType': type, 'System.State': 'Done', 'System.Tags': tags },
      },
    ];

    it('does not dispatch a Bug already tagged qa-verified', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101]);
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) =>
        withTags(ids[0], 'Bug', 'Phase3; qa-verified'),
      );
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(result.ineligible[0].reason).toMatch(/already tagged 'qa-verified'/);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('still dispatches a Done Bug that is awaiting retest (no tag)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101]);
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) =>
        withTags(ids[0], 'Bug', 'Phase3'),
      );
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
    });

    it('matches the tag regardless of case and surrounding whitespace', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101]);
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) =>
        withTags(ids[0], 'Bug', 'a;  QA-Verified  ; b'),
      );
      expect((await service.startQaBatch(project.id as string)).dispatched).toHaveLength(0);
    });

    /**
     * A passing QA leaves the **Story** in Done too — exactly what enumeration selects — so without
     * the tag every wave re-tests and re-charges for Stories that already passed (observed live:
     * Story 19546 tested three times for $4.62 before this was fixed).
     */
    it('does not re-test a Story already tagged qa-verified', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100]);
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) =>
        withTags(ids[0], 'Product Backlog Item', 'qa-verified'),
      );
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(result.ineligible[0].reason).toMatch(/already tagged 'qa-verified'/);
    });

    it('still tests a Done Story that has never passed QA', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100]);
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) =>
        withTags(ids[0], 'Product Backlog Item', 'Phase3'),
      );
      expect((await service.startQaBatch(project.id as string)).dispatched).toHaveLength(1);
    });
  });

  describe('startQaBatch — dry run (confirmation dialog)', () => {
    it('reports what would run without enqueueing or dispatching anything', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101]);
      const result = await service.startQaBatch(project.id as string, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.candidates).toBe(2);
      expect(result.dispatched.map((d) => d.workItemId)).toEqual(['100', '101']);
      expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('applies the same capacity budget to the preview', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 101, 102]);
      const result = await service.startQaBatch(project.id as string, {
        dryRun: true,
        maxDispatch: 2,
      });
      expect(result.dispatched).toHaveLength(2);
      expect(result.deferred).toEqual(['102']);
    });

    it('marks a real wave as not a dry run', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100]);
      expect((await service.startQaBatch(project.id as string)).dryRun).toBe(false);
    });
  });

  describe('startQaBatch — eligibility (verified project state model)', () => {
    it('records a non-Story/Bug work item as ineligible with a reason', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100, 200]);
      ado.getWorkItemsBatch.mockImplementation((ids: number[]) => {
        if (ids[0] === 200) {
          return Promise.resolve([
            { id: 200, url: '', fields: { 'System.WorkItemType': 'Task', 'System.State': 'Done' } },
          ]);
        }
        return Promise.resolve(readyForQaAdo(ids));
      });
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
      expect(result.ineligible).toEqual([
        { workItemId: '200', reason: expect.stringMatching(/not a Story or Bug/) },
      ]);
    });

    it('records a Story that is not Done as ineligible (not ready for QA)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100]);
      ado.getWorkItemsBatch.mockResolvedValue([
        {
          id: 100,
          url: '',
          fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.State': 'Committed' },
        },
      ]);
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(result.ineligible[0].reason).toMatch(/not ready for QA/);
    });

    it('treats a Bug in Done as Ready-for-QA (awaiting retest) — verified state, not "Resolved"', async () => {
      ado.queryWorkItemIds.mockResolvedValue([101]);
      ado.getWorkItemsBatch.mockResolvedValue([
        { id: 101, url: '', fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Done' } },
      ]);
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
    });

    it('records a non-existent work item as ineligible', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100]);
      ado.getWorkItemsBatch.mockResolvedValue([]);
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(0);
      expect(result.ineligible[0].reason).toMatch(/does not exist/);
    });
  });

  describe('startQaBatch — resilience', () => {
    it('does not hard-fail when the execution backend is unreachable (item still counted dispatched)', async () => {
      ado.queryWorkItemIds.mockResolvedValue([100]);
      dispatcher.dispatch.mockRejectedValue(new Error('no cluster'));
      const result = await service.startQaBatch(project.id as string);
      expect(result.dispatched).toHaveLength(1);
    });

    it('propagates a 404 for an unknown project', async () => {
      projects.findById.mockRejectedValue(new NotFoundException('no project'));
      await expect(service.startQaBatch('missing')).rejects.toThrow(NotFoundException);
    });
  });
});

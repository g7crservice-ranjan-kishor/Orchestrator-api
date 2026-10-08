import { BadRequestException } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { JobsService } from '../jobs/jobs.service';
import { JobDispatchService } from '../jobs/job-dispatch.service';
import { ProjectsService } from '../projects/projects.service';
import { JobRole, JobState } from '../jobs/job-state';

/**
 * The only gate that ever sees the whole product.
 *
 * Every other one judges a single repository: unit tests mock the API, so the mock returns whatever
 * the interface already believes; API tests have no interface; and a QA agent asked to verify "end
 * to end" reaches for `curl`, which never sends an `Origin` header and never renders a page. All
 * were green while the last product could not serve one request from its own UI.
 */
describe('VerificationService', () => {
  let service: VerificationService;
  let jobs: { enqueue: jest.Mock; listForProject: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let projects: { findById: jest.Mock };

  const repos = ['https://x/_git/api', 'https://x/_git/ui'];

  const job = (over: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    role: JobRole.Verify,
    state: JobState.Running,
    result: null,
    createdAt: new Date('2026-09-29T10:00:00Z'),
    updatedAt: new Date('2026-09-29T10:05:00Z'),
    ...over,
  });

  beforeEach(() => {
    jobs = {
      enqueue: jest.fn().mockResolvedValue(job()),
      listForProject: jest.fn().mockResolvedValue([]),
    };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    projects = { findById: jest.fn().mockResolvedValue({ targetRepos: repos }) };
    service = new VerificationService(
      jobs as unknown as JobsService,
      dispatcher as unknown as JobDispatchService,
      projects as unknown as ProjectsService,
    );
  });

  it('starts a verification run and dispatches its pod', async () => {
    await service.start('p1');
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ role: JobRole.Verify, repo: repos[0] }),
    );
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });

  /** Re-clicking must not start a second pod: one product, one verification at a time. */
  it('returns the run already in flight instead of starting another', async () => {
    jobs.listForProject.mockResolvedValue([job({ state: JobState.Running })]);
    const view = await service.start('p1');
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(view.runId).toBe('run-1');
  });

  it('starts a new run once the previous one finished', async () => {
    jobs.listForProject.mockResolvedValue([job({ state: JobState.Completed })]);
    await service.start('p1');
    expect(jobs.enqueue).toHaveBeenCalled();
  });

  it('refuses a project with no repositories, rather than verifying nothing', async () => {
    projects.findById.mockResolvedValue({ targetRepos: [] });
    await expect(service.start('p1')).rejects.toBeInstanceOf(BadRequestException);
  });

  /** The execution backend being down must not lose the run — it stays Queued. */
  it('leaves the job queued when the cluster is unreachable', async () => {
    dispatcher.dispatch.mockRejectedValue(new Error('cluster down'));
    await expect(service.start('p1')).resolves.toBeDefined();
  });

  it('reports the check report once the run has finished', async () => {
    jobs.listForProject.mockResolvedValue([
      job({ state: JobState.Failed, result: { output: '[FAIL] Browser can call the API (CORS)' } }),
    ]);
    const view = await service.latest('p1');
    expect(view.passed).toBe(false);
    expect(view.report).toContain('CORS');
    expect(view.finishedAt).not.toBeNull();
  });

  it('says nothing has been verified yet when there is no run', async () => {
    const view = await service.latest('p1');
    expect(view.runId).toBeNull();
    expect(view.passed).toBeNull();
  });

  /** A run still going has no verdict — reporting one either way would be a guess. */
  it('withholds a verdict while the run is still going', async () => {
    jobs.listForProject.mockResolvedValue([job({ state: JobState.Running })]);
    const view = await service.latest('p1');
    expect(view.passed).toBeNull();
    expect(view.finishedAt).toBeNull();
  });

  it('ignores runs that are not verifications', async () => {
    jobs.listForProject.mockResolvedValue([job({ role: JobRole.Developer })]);
    expect((await service.latest('p1')).runId).toBeNull();
  });
});

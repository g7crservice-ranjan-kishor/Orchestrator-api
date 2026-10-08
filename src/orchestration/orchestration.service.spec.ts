import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../common/config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { ProjectsService } from '../projects/projects.service';
import { DevelopmentService } from '../development/development.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { OrchestrationService } from './orchestration.service';
import { QaBatchDispatcher } from './qa-batch.seam';

/**
 * Unit tests for the scheduler tick logic (gating, capacity math, leg routing, audit). Scheduling
 * itself is disabled under test (config.isTest); tick() is invoked directly.
 */
describe('OrchestrationService.tick', () => {
  const projectA = { id: 'projA' } as unknown as ProjectDocument;

  let config: {
    isTest: boolean;
    orchestrationEnabled: boolean;
    orchestrationIntervalMs: number;
    maxConcurrentRuns: number;
    orchestrationRoles: string[];
  };
  let jobs: { countActive: jest.Mock };
  let projects: { findAll: jest.Mock };
  let development: { startDevelopmentBatch: jest.Mock };
  let audit: { append: jest.Mock };

  const batchResult = (
    dispatched: string[],
    skippedActive: string[] = [],
    deferred: string[] = [],
  ) => ({
    candidates: dispatched.length + skippedActive.length + deferred.length,
    dispatched: dispatched.map((runId, i) => ({ runId, workItemId: `wi-${i}` })),
    skippedActive,
    deferred,
    ineligible: [],
  });

  const build = (qa?: QaBatchDispatcher | null): OrchestrationService =>
    new OrchestrationService(
      config as unknown as AppConfigService,
      {} as SchedulerRegistry,
      jobs as unknown as JobsService,
      projects as unknown as ProjectsService,
      development as unknown as DevelopmentService,
      audit as unknown as AuditService,
      qa ?? undefined,
    );

  beforeEach(() => {
    config = {
      isTest: true,
      orchestrationEnabled: true,
      orchestrationIntervalMs: 300000,
      maxConcurrentRuns: 5,
      orchestrationRoles: ['developer'],
    };
    jobs = { countActive: jest.fn().mockResolvedValue(0) };
    projects = { findAll: jest.fn().mockResolvedValue([projectA]) };
    development = { startDevelopmentBatch: jest.fn().mockResolvedValue(batchResult([])) };
    audit = { append: jest.fn().mockResolvedValue(null) };
  });

  it('dispatches the Developer batch when enabled and idle', async () => {
    development.startDevelopmentBatch.mockResolvedValue(batchResult(['r1', 'r2']));
    const wave = await build().tick();
    expect(development.startDevelopmentBatch).toHaveBeenCalledWith('projA', { maxDispatch: 5 });
    expect(wave.dispatched).toBe(2);
    expect(audit.append).toHaveBeenCalledTimes(2); // one audit line per dispatch
  });

  it('no-ops when ORCHESTRATION_ENABLED is false (pause/stop)', async () => {
    config.orchestrationEnabled = false;
    const wave = await build().tick();
    expect(wave.dispatched).toBe(0);
    expect(development.startDevelopmentBatch).not.toHaveBeenCalled();
  });

  it('no-ops at capacity (activeRuns >= MAX_CONCURRENT_RUNS)', async () => {
    jobs.countActive.mockResolvedValue(5); // == cap
    const wave = await build().tick();
    expect(wave.dispatched).toBe(0);
    expect(development.startDevelopmentBatch).not.toHaveBeenCalled();
  });

  it('passes only the remaining capacity as the batch budget', async () => {
    jobs.countActive.mockResolvedValue(3); // capacity = 5 - 3 = 2
    await build().tick();
    expect(development.startDevelopmentBatch).toHaveBeenCalledWith('projA', { maxDispatch: 2 });
  });

  it('does not attempt the QA leg when qa is not in ORCHESTRATION_ROLES (default)', async () => {
    const qa: QaBatchDispatcher = { startQaBatch: jest.fn().mockResolvedValue({ dispatched: [] }) };
    await build(qa).tick(); // roles = ['developer']
    expect(qa.startQaBatch).not.toHaveBeenCalled();
  });

  it('QA leg stays inert when qa role is on but no dispatcher is bound (Phase 3 absent)', async () => {
    config.orchestrationRoles = ['developer', 'qa'];
    const wave = await build(null).tick(); // no QA dispatcher
    expect(wave.dispatched).toBe(0);
    // developer leg still ran without error
    expect(development.startDevelopmentBatch).toHaveBeenCalled();
  });

  it('drives the QA leg when qa role is on and a dispatcher is bound', async () => {
    config.orchestrationRoles = ['developer', 'qa'];
    const qa: QaBatchDispatcher = {
      startQaBatch: jest
        .fn()
        .mockResolvedValue({ dispatched: [{ runId: 'q1', workItemId: '900' }] }),
    };
    const wave = await build(qa).tick();
    expect(qa.startQaBatch).toHaveBeenCalledWith('projA', { maxDispatch: 5 });
    expect(wave.dispatched).toBe(1);
  });

  it('gives the QA leg only the capacity left after the Developer leg (shared cap within a tick)', async () => {
    config.orchestrationRoles = ['developer', 'qa'];
    development.startDevelopmentBatch.mockResolvedValue(batchResult(['r1', 'r2'])); // consumes 2 of 5
    const qa: QaBatchDispatcher = { startQaBatch: jest.fn().mockResolvedValue({ dispatched: [] }) };
    await build(qa).tick();
    expect(qa.startQaBatch).toHaveBeenCalledWith('projA', { maxDispatch: 3 });
  });

  it('reports qaLegAvailable true once a QA dispatcher is bound (Phase 3 present)', async () => {
    const qa: QaBatchDispatcher = { startQaBatch: jest.fn().mockResolvedValue({ dispatched: [] }) };
    const status = await build(qa).getStatus();
    expect(status.qaLegAvailable).toBe(true);
  });

  it('continues the wave when one project dispatch fails (resilient, no throw)', async () => {
    projects.findAll.mockResolvedValue([
      { id: 'projA' } as unknown as ProjectDocument,
      { id: 'projB' } as unknown as ProjectDocument,
    ]);
    development.startDevelopmentBatch
      .mockRejectedValueOnce(new Error('ADO unreachable')) // projA fails
      .mockResolvedValueOnce(batchResult(['r1'])); // projB succeeds
    const wave = await build().tick();
    expect(wave.dispatched).toBe(1); // projB still dispatched
    expect(development.startDevelopmentBatch).toHaveBeenCalledTimes(2);
  });

  it('exposes status (enabled, roles, activeRuns, qaLegAvailable, lastTickAt)', async () => {
    jobs.countActive.mockResolvedValue(2);
    const svc = build(null);
    await svc.tick();
    const status = await svc.getStatus();
    expect(status).toMatchObject({
      enabled: true,
      roles: ['developer'],
      maxConcurrentRuns: 5,
      activeRuns: 2,
      qaLegAvailable: false,
    });
    expect(status.lastTickAt).not.toBeNull();
  });
});

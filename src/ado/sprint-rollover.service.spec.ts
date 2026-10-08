import { BadRequestException } from '@nestjs/common';
import { AdoClientService, AdoIteration } from './ado-client.service';
import { AdoBoardService, Board, BoardTask } from './ado-board.service';
import { SprintService } from './sprint.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { ProjectsService } from '../projects/projects.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import {
  DEFAULT_SPRINT_DAYS,
  findNextIteration,
  planRolloverDates,
  SprintRolloverService,
} from './sprint-rollover.service';
import { adoStub } from '../testing/ado-stub';

const iteration = (over: Partial<AdoIteration> & { name: string }): AdoIteration => ({
  path: `Proj\\${over.name}`,
  timeFrame: 'future',
  startDate: null,
  finishDate: null,
  ...over,
});

/** The dates are the whole point of the feature, so they are tested as pure functions. */
describe('planRolloverDates', () => {
  const now = new Date('2026-09-22T09:00:00Z'); // a Tuesday, mid-morning

  it('ends the current sprint yesterday and starts the next today', () => {
    const dates = planRolloverDates(
      {
        name: 'S1',
        path: 'p',
        startDate: '2026-09-08T00:00:00Z',
        finishDate: '2026-10-03T00:00:00Z',
      },
      { name: 'S2', path: 'p', startDate: null, finishDate: null },
      now,
    );
    expect(dates.currentFinish).toBe('2026-09-21T00:00:00.000Z');
    expect(dates.nextStart).toBe('2026-09-22T00:00:00.000Z');
  });

  it('keeps the next sprint its own configured length', () => {
    const dates = planRolloverDates(
      {
        name: 'S1',
        path: 'p',
        startDate: '2026-09-08T00:00:00Z',
        finishDate: '2026-09-19T00:00:00Z',
      },
      // 7 days, inclusive of both bounds
      {
        name: 'S2',
        path: 'p',
        startDate: '2026-10-05T00:00:00Z',
        finishDate: '2026-10-11T00:00:00Z',
      },
      now,
    );
    expect(dates.nextStart).toBe('2026-09-22T00:00:00.000Z');
    expect(dates.nextFinish).toBe('2026-09-28T00:00:00.000Z'); // 22nd + 6 = 7 days
  });

  it('inherits the closing sprint length when the next sprint has no dates', () => {
    const dates = planRolloverDates(
      // 12 days
      {
        name: 'S1',
        path: 'p',
        startDate: '2026-09-08T00:00:00Z',
        finishDate: '2026-09-19T00:00:00Z',
      },
      { name: 'S2', path: 'p', startDate: null, finishDate: null },
      now,
    );
    expect(dates.nextFinish).toBe('2026-10-03T00:00:00.000Z'); // 22nd + 11 = 12 days
  });

  it('falls back to the default length when neither sprint is dated', () => {
    const dates = planRolloverDates(
      { name: 'S1', path: 'p', startDate: null, finishDate: null },
      { name: 'S2', path: 'p', startDate: null, finishDate: null },
      now,
    );
    const start = new Date(dates.nextStart).getTime();
    const finish = new Date(dates.nextFinish).getTime();
    expect((finish - start) / 86400000 + 1).toBe(DEFAULT_SPRINT_DAYS);
  });

  /**
   * The case that used to be refused outright. A sprint started today is compressed into
   * yesterday — start *and* finish — so it is a valid one-day sprint entirely in the past. Without
   * moving the start, the finish would land before it and Azure DevOps would reject the write.
   */
  describe('closing a sprint on the day it started', () => {
    it('moves the start back with the finish, so the sprint stays valid', () => {
      const dates = planRolloverDates(
        { name: 'S1', path: 'p', startDate: '2026-09-22T00:00:00Z', finishDate: null }, // today
        { name: 'S2', path: 'p', startDate: null, finishDate: null },
        now,
      );
      expect(dates.currentStart).toBe('2026-09-21T00:00:00.000Z');
      expect(dates.currentFinish).toBe('2026-09-21T00:00:00.000Z');
      expect(new Date(dates.currentFinish).getTime()).toBeGreaterThanOrEqual(
        new Date(dates.currentStart).getTime(),
      );
    });

    /** The point of the whole thing: the next sprint is active today, not tomorrow. */
    it('starts the next sprint today', () => {
      const dates = planRolloverDates(
        { name: 'S1', path: 'p', startDate: '2026-09-22T00:00:00Z', finishDate: null },
        { name: 'S2', path: 'p', startDate: null, finishDate: null },
        now,
      );
      expect(dates.nextStart).toBe('2026-09-22T00:00:00.000Z');
    });

    /** Overlap is what made the naive fix fail: ADO then keeps the earlier sprint as current. */
    it('leaves no overlap between the closed sprint and the new one', () => {
      const dates = planRolloverDates(
        { name: 'S1', path: 'p', startDate: '2026-09-22T00:00:00Z', finishDate: null },
        { name: 'S2', path: 'p', startDate: null, finishDate: null },
        now,
      );
      expect(new Date(dates.currentFinish).getTime()).toBeLessThan(
        new Date(dates.nextStart).getTime(),
      );
    });

    /** Four sprints in one day: each roll compresses the sprint the previous roll just started. */
    it('can be repeated the same day', () => {
      const first = planRolloverDates(
        { name: 'S1', path: 'p', startDate: '2026-09-22T00:00:00Z', finishDate: null },
        { name: 'S2', path: 'p', startDate: null, finishDate: null },
        now,
      );
      const second = planRolloverDates(
        { name: 'S2', path: 'p', startDate: first.nextStart, finishDate: first.nextFinish },
        { name: 'S3', path: 'p', startDate: null, finishDate: null },
        now,
      );
      expect(second.currentStart).toBe('2026-09-21T00:00:00.000Z');
      expect(second.nextStart).toBe('2026-09-22T00:00:00.000Z');
    });
  });

  it('leaves a sprint that started earlier with its real start date', () => {
    const dates = planRolloverDates(
      { name: 'S1', path: 'p', startDate: '2026-09-10T00:00:00Z', finishDate: null },
      { name: 'S2', path: 'p', startDate: null, finishDate: null },
      now,
    );
    expect(dates.currentStart).toBe('2026-09-10T00:00:00.000Z'); // history preserved
    expect(dates.currentFinish).toBe('2026-09-21T00:00:00.000Z');
  });
});

describe('findNextIteration', () => {
  const list = [iteration({ name: 'S1' }), iteration({ name: 'S2' }), iteration({ name: 'S3' })];

  it('returns the iteration after the current one, in ADO backlog order', () => {
    expect(findNextIteration(list, 'Proj\\S2')?.name).toBe('S3');
  });

  it('returns null for the last iteration', () => {
    expect(findNextIteration(list, 'Proj\\S3')).toBeNull();
  });

  it('returns null when the current path is not in the list', () => {
    expect(findNextIteration(list, 'Proj\\Nope')).toBeNull();
  });
});

describe('AdoClientService.relativeIterationPath', () => {
  it('strips the project root segment', () => {
    expect(AdoClientService.relativeIterationPath('Proj', 'Proj\\Sprint 2')).toBe('Sprint%202');
  });

  it('keeps nested iteration folders', () => {
    expect(AdoClientService.relativeIterationPath('Proj', 'Proj\\Release 1\\Sprint 2')).toBe(
      'Release%201/Sprint%202',
    );
  });

  it('tolerates a path that omits the project root', () => {
    expect(AdoClientService.relativeIterationPath('Proj', 'Sprint 2')).toBe('Sprint%202');
  });
});

describe('SprintRolloverService', () => {
  const projectId = '6aaa363961610d4d4107c5cf';
  const user = { userId: 'u1', email: 'em@example.com' } as unknown as AuthenticatedUser;

  let projects: { findById: jest.Mock };
  let sprints: { listIterations: jest.Mock; invalidate: jest.Mock };
  let board: { getBoard: jest.Mock };
  let client: { updateIterationDates: jest.Mock };
  let audit: { append: jest.Mock };
  let service: SprintRolloverService;

  const task = (over: Partial<BoardTask>): BoardTask =>
    ({
      adoId: 1,
      key: '1',
      title: 'A Task',
      status: 'Done',
      sprint: 'Sprint 1',
      agentRunning: false,
      ...over,
    }) as BoardTask;

  const boardWith = (tasks: BoardTask[]): Board =>
    ({ pushed: true, currentSprint: 'Sprint 1', columns: [{ status: 'To Do', tasks }] }) as Board;

  beforeEach(() => {
    projects = { findById: jest.fn().mockResolvedValue({ adoTarget: { project: 'Proj' } }) };
    sprints = {
      listIterations: jest
        .fn()
        .mockResolvedValue([
          iteration({ name: 'Sprint 1', timeFrame: 'current', startDate: '2026-09-08T00:00:00Z' }),
          iteration({ name: 'Sprint 2' }),
        ]),
      invalidate: jest.fn(),
    };
    board = { getBoard: jest.fn().mockResolvedValue(boardWith([task({})])) };
    client = { updateIterationDates: jest.fn().mockResolvedValue({}) };
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    service = new SprintRolloverService(
      projects as unknown as ProjectsService,
      sprints as unknown as SprintService,
      board as unknown as AdoBoardService,
      adoStub(client),
      audit as unknown as AuditService,
    );
  });

  it('rejects a project with no Azure DevOps target', async () => {
    projects.findById.mockResolvedValue({ adoTarget: undefined });
    await expect(service.completeCurrentSprint(projectId, user)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('blocks when Azure DevOps reports no active sprint', async () => {
    sprints.listIterations.mockResolvedValue([iteration({ name: 'Sprint 1' })]); // all future
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.ok).toBe(false);
    expect(plan.blockers[0]).toMatch(/no active sprint/i);
  });

  it('blocks when there is no sprint after the active one', async () => {
    sprints.listIterations.mockResolvedValue([
      iteration({ name: 'Sprint 1', timeFrame: 'current' }),
    ]);
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.ok).toBe(false);
    expect(plan.blockers[0]).toMatch(/no sprint after Sprint 1/i);
  });

  it('blocks while a Developer agent is still running in the sprint', async () => {
    board.getBoard.mockResolvedValue(
      boardWith([task({ adoId: 19565, status: 'In Progress', agentRunning: true })]),
    );
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.ok).toBe(false);
    expect(plan.blockers[0]).toContain('#19565');
    expect(client.updateIterationDates).not.toHaveBeenCalled();
  });

  /** A sprint may only be closed once its work is finished — unfinished Tasks are a hard stop. */
  it('blocks while the active sprint still has Tasks that are not Done', async () => {
    board.getBoard.mockResolvedValue(
      boardWith([task({ adoId: 1 }), task({ adoId: 2, status: 'To Do' })]),
    );
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.ok).toBe(false);
    expect(plan.blockers[0]).toMatch(/still has 1 Task that is not Done/i);
    expect(plan.carryOver).toEqual([{ adoId: 2, key: '1', title: 'A Task', status: 'To Do' }]);
  });

  it('allows the rollover when every Task in the sprint is Done', async () => {
    board.getBoard.mockResolvedValue(boardWith([task({ adoId: 1 }), task({ adoId: 2 })]));
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.ok).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.carryOver).toEqual([]);
  });

  it('does not write when unfinished Tasks block the rollover', async () => {
    board.getBoard.mockResolvedValue(boardWith([task({ adoId: 2, status: 'In Progress' })]));
    const plan = await service.completeCurrentSprint(projectId, user);
    expect(plan.applied).toBe(false);
    expect(client.updateIterationDates).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('ignores Tasks from other sprints', async () => {
    board.getBoard.mockResolvedValue(
      boardWith([task({ adoId: 9, status: 'To Do', sprint: 'Sprint 2' })]),
    );
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.carryOver).toHaveLength(0);
    expect(plan.ok).toBe(true);
  });

  /**
   * Previously refused outright. A whole project may legitimately be run through in a day, so the
   * sprint is compressed into yesterday instead — the next one becomes current immediately.
   */
  it('closes a sprint on the day it started', async () => {
    const today = new Date().toISOString();
    sprints.listIterations.mockResolvedValue([
      iteration({ name: 'Sprint 3', timeFrame: 'current', startDate: today }),
      iteration({ name: 'Sprint 4' }),
    ]);
    const plan = await service.completeCurrentSprint(projectId, user);
    expect(plan.ok).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(client.updateIterationDates).toHaveBeenCalledTimes(2);
    // Start and finish both move, so the closed sprint never finishes before it began.
    expect(plan.newCurrentStart).toBe(plan.newCurrentFinish);
    expect(new Date(plan.newCurrentFinish!).getTime()).toBeLessThan(
      new Date(plan.newNextStart!).getTime(),
    );
  });

  it('changes nothing on a dry run', async () => {
    const plan = await service.completeCurrentSprint(projectId, user, { dryRun: true });
    expect(plan.ok).toBe(true);
    expect(plan.dryRun).toBe(true);
    expect(plan.applied).toBe(false);
    expect(plan.newNextStart).not.toBeNull();
    expect(client.updateIterationDates).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(sprints.invalidate).not.toHaveBeenCalled();
  });

  it('writes both iteration dates, drops the cache and audits the rollover', async () => {
    const plan = await service.completeCurrentSprint(projectId, user);
    expect(plan.applied).toBe(true);
    expect(client.updateIterationDates).toHaveBeenCalledTimes(2);
    expect(client.updateIterationDates).toHaveBeenNthCalledWith(
      1,
      'Proj',
      'Proj\\Sprint 1',
      plan.newCurrentStart,
      plan.newCurrentFinish,
    );
    expect(client.updateIterationDates).toHaveBeenNthCalledWith(
      2,
      'Proj',
      'Proj\\Sprint 2',
      plan.newNextStart,
      plan.newNextFinish,
    );
    // With the project id, not without it: SprintService keys its cache by owner *and* project,
    // and the board reads with the owner. See the real-cache test below for why a mock alone is
    // not enough to pin this.
    expect(sprints.invalidate).toHaveBeenCalledWith('Proj', projectId);
    expect(sprints.listIterations).toHaveBeenCalledWith('Proj', projectId);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SprintCompleted,
        metadata: expect.objectContaining({
          closed: expect.objectContaining({ sprint: 'Sprint 1' }),
          started: expect.objectContaining({ sprint: 'Sprint 2' }),
        }),
      }),
    );
  });

  it('does not write or audit when a blocker applies', async () => {
    sprints.listIterations.mockResolvedValue([
      iteration({ name: 'Sprint 1', timeFrame: 'current' }),
    ]);
    const plan = await service.completeCurrentSprint(projectId, user);
    expect(plan.applied).toBe(false);
    expect(client.updateIterationDates).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });
});

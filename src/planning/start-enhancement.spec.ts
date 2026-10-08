import { BadRequestException } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { BacklogItemType, DraftKind, DraftStatus } from './schemas/draft.schema';

/**
 * Starting a second planning cycle on a product that already exists.
 *
 * An enhancement is a **separate draft**, not an edit of the first — which is what lets the EM
 * session, the clarification thread, the backlog gates, the push and both queues work on it with no
 * changes at all: each of them acts on "the project's plan", and an enhancement simply *is* that
 * plan while it is in flight.
 *
 * Both refusals exist to keep that sentence true. Two unfinished plans would make "the project's
 * plan" unanswerable; a project with nothing in Azure DevOps has nothing to enhance, and the person
 * means to change the plan they already have.
 */

const pushedItem = (adoId: number | null) => ({
  id: `task-${adoId ?? 'new'}`,
  type: BacklogItemType.Task,
  adoId,
});

const draft = (over: Record<string, unknown> = {}) => ({
  kind: DraftKind.Initial,
  seq: 0,
  status: DraftStatus.Approved,
  title: null,
  backlog: [pushedItem(730)],
  ...over,
});

describe('PlanningService.startEnhancement', () => {
  const PROJECT = '6abe2b5bd8ca853c7a61bd31';
  let service: PlanningService;
  let saved: Record<string, unknown> | null;
  let dispatched: boolean;

  /** Builds the service with just enough around it to exercise the creation rules. */
  const build = (drafts: unknown[], requirements: unknown[] = [{ _id: 'req-1' }]) => {
    saved = null;
    dispatched = false;
    const model = function (this: Record<string, unknown>, doc: Record<string, unknown>) {
      Object.assign(this, doc);
      this.save = () => {
        saved = { ...this };
        return Promise.resolve(this);
      };
    } as unknown as { find: jest.Mock };
    model.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(drafts) }),
    });

    const instance = Object.create(PlanningService.prototype) as PlanningService;
    Object.assign(instance, {
      draftModel: model,
      projects: { findById: jest.fn().mockResolvedValue({ id: PROJECT }) },
      requirements: { listForProject: jest.fn().mockResolvedValue(requirements) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      dispatchRun: jest.fn().mockImplementation(() => {
        dispatched = true;
        return Promise.resolve('run-1');
      }),
    });
    service = instance;
    return instance;
  };

  it('creates the first enhancement as ENH-001, after the initial plan', async () => {
    build([draft()]);
    await service.startEnhancement(PROJECT, { title: 'Implement Dark Mode' });

    expect(saved).toMatchObject({
      kind: DraftKind.Enhancement,
      seq: 1,
      title: 'Implement Dark Mode',
      status: DraftStatus.Planning,
    });
  });

  it('starts the EM session against it', async () => {
    build([draft()]);
    await service.startEnhancement(PROJECT, { title: 'Implement Dark Mode' });
    expect(dispatched).toBe(true);
    expect(saved).toMatchObject({ currentRunId: 'run-1' });
  });

  it('numbers the next one after the highest, never reusing a number', async () => {
    build([draft(), draft({ kind: DraftKind.Enhancement, seq: 3 })]);
    await service.startEnhancement(PROJECT, { title: 'Export to CSV' });
    expect(saved).toMatchObject({ seq: 4 });
  });

  /**
   * An enhancement is about the requirement just written for it, not the product's first one.
   *
   * This is pinned with the order `listForProject` really returns — **newest first** — because the
   * first version of this test used oldest-first fixtures and so agreed with the bug: ENH-001 was
   * handed the original "Build a simple Employee Management System" requirement and planned the
   * entire product again, six epics of work that already existed.
   */
  it('plans against the newest requirement, whatever order they arrive in', async () => {
    const older = { _id: 'req-old', createdAt: new Date('2026-10-01T09:45:00Z') };
    const newer = { _id: 'req-new', createdAt: new Date('2026-10-05T12:13:00Z') };

    build([draft()], [newer, older]); // newest first, as the service really receives them
    await service.startEnhancement(PROJECT, { title: 'Implement Dark Mode' });
    expect(saved).toMatchObject({ requirementId: 'req-new' });

    build([draft()], [older, newer]); // and the other way round, so order cannot decide it
    await service.startEnhancement(PROJECT, { title: 'Implement Dark Mode' });
    expect(saved).toMatchObject({ requirementId: 'req-new' });
  });

  it('plans against a requirement named outright', async () => {
    build([draft()], [{ _id: 'req-old' }, { _id: 'req-new' }]);
    await service.startEnhancement(PROJECT, {
      title: 'Implement Dark Mode',
      requirementId: 'req-chosen',
    });
    expect(saved).toMatchObject({ requirementId: 'req-chosen' });
  });

  /** One cycle at a time, or "the project's plan" stops having an answer. */
  it('refuses while another plan is still being worked on', async () => {
    build([draft(), draft({ kind: DraftKind.Enhancement, seq: 1, status: DraftStatus.Planning })]);
    await expect(service.startEnhancement(PROJECT, { title: 'Export to CSV' })).rejects.toThrow(
      BadRequestException,
    );
    expect(saved).toBeNull();
    expect(dispatched).toBe(false);
  });

  it('names the plan that is in the way', async () => {
    build([
      draft(),
      draft({
        kind: DraftKind.Enhancement,
        seq: 1,
        status: DraftStatus.Planning,
        title: 'Implement Dark Mode',
      }),
    ]);
    await expect(service.startEnhancement(PROJECT, { title: 'Export to CSV' })).rejects.toThrow(
      /ENH-001 — Implement Dark Mode/,
    );
  });

  /** Nothing built means nothing to enhance; the person means to change the plan they have. */
  it('refuses when the project has nothing in Azure DevOps', async () => {
    build([draft({ backlog: [pushedItem(null)] })]);
    await expect(
      service.startEnhancement(PROJECT, { title: 'Implement Dark Mode' }),
    ).rejects.toThrow(/nothing to enhance/i);
    expect(dispatched).toBe(false);
  });

  it('refuses an enhancement with no title', async () => {
    build([draft()]);
    await expect(service.startEnhancement(PROJECT, { title: '   ' })).rejects.toThrow(
      /give the enhancement a title/i,
    );
  });

  it('trims the title rather than storing the spaces', async () => {
    build([draft()]);
    await service.startEnhancement(PROJECT, { title: '  Implement Dark Mode  ' });
    expect(saved).toMatchObject({ title: 'Implement Dark Mode' });
  });
});

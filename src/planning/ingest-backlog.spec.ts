import { PlanningService } from './planning.service';
import { BacklogItem, BacklogItemType, DraftDocument, DraftStatus } from './schemas/draft.schema';

function item(
  over: Partial<BacklogItem> & Pick<BacklogItem, 'id' | 'type' | 'title'>,
): BacklogItem {
  return {
    description: 'x',
    acceptanceCriteria: '- checkable',
    parentId: null,
    order: 0,
    priority: 2,
    estimate: null,
    dependsOn: [],
    repo: 'taskmanager-api',
    sprint: 'Sprint 1',
    attachments: [],
    adoId: null,
    ...over,
  } as BacklogItem;
}

/** A complete, valid four-level backlog — nothing for the validator to complain about. */
const clean = (): BacklogItem[] => [
  item({ id: 'e1', type: BacklogItemType.Epic, title: 'Epic' }),
  item({ id: 'e1-f1', type: BacklogItemType.Feature, title: 'Feature', parentId: 'e1' }),
  item({ id: 'e1-f1-s1', type: BacklogItemType.Story, title: 'Story', parentId: 'e1-f1' }),
  item({
    id: 'e1-f1-s1-t1',
    type: BacklogItemType.Task,
    title: 'Scaffold the project skeleton',
    parentId: 'e1-f1-s1',
    acceptanceCriteria: '',
  }),
];

/**
 * What `ingestBacklog` validates after a correction.
 *
 * The incident: the draft was validated against `items` — the payload that had just arrived. On a
 * correction that payload is a *patch*: an id plus the one field being changed. So every patched
 * item looked like it was missing a title, and every problem the patch did not touch became
 * invisible. The Scrum Master was then sent a correction asking it to fix eleven titles that were
 * already correct, while twenty-two Stories that genuinely had no acceptance criteria went
 * unmentioned. The merged draft is the only thing worth validating.
 */
describe('ingestBacklog validation target', () => {
  let service: PlanningService;
  let draft: DraftDocument;
  let dispatch: jest.SpyInstance;

  const makeDraft = (over: Partial<DraftDocument>): DraftDocument =>
    ({
      projectId: { toString: () => 'proj-1' },
      status: DraftStatus.BacklogDrafting,
      backlog: [],
      planFeedback: null,
      backlogCorrection: false,
      backlogAttempts: 0,
      backlogLastErrors: 0,
      backlogErrorSignature: '',
      runNote: null,
      currentRunId: 'run-1',
      save: jest.fn(function (this: DraftDocument) {
        return Promise.resolve(this);
      }),
      ...over,
    }) as unknown as DraftDocument;

  const build = (d: DraftDocument): PlanningService => {
    const svc = new PlanningService(
      { findOne: jest.fn().mockResolvedValue(d) } as never,
      { findById: jest.fn().mockResolvedValue({ targetRepos: ['taskmanager-api'] }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // Knowledge base: unconfigured, which is what every run saw before it existed.
      { readAll: jest.fn().mockResolvedValue([]) } as never,
    );
    dispatch = jest
      .spyOn(svc as unknown as { dispatchRun: () => Promise<string> }, 'dispatchRun')
      .mockResolvedValue('run-2');
    return svc;
  };

  /**
   * How many rounds the Scrum Master actually gets.
   *
   * Both real products stopped at exactly two attempts out of eight, handing a person a backlog
   * with blocking issues the loop had the budget to fix. These drive the decision through
   * `ingestBacklog` rather than asserting on the rule, because the rule read as reasonable in
   * isolation — it was only wrong against what the agent really does between rounds.
   */
  describe('how long it keeps correcting', () => {
    /** A Task naming a repository the project does not have is a blocking issue. */
    const broken = (ids: string[]) => [
      item({ id: 'e1', type: BacklogItemType.Epic, title: 'Epic' }),
      item({ id: 'e1-f1', type: BacklogItemType.Feature, title: 'Feature', parentId: 'e1' }),
      item({ id: 'e1-f1-s1', type: BacklogItemType.Story, title: 'Story', parentId: 'e1-f1' }),
      ...ids.map((id) =>
        item({
          id,
          type: BacklogItemType.Task,
          title: `Task ${id}`,
          parentId: 'e1-f1-s1',
          repo: 'not-a-real-repo',
        }),
      ),
    ];

    it('asks again when the issues are different, even with the same count', async () => {
      draft = makeDraft({
        backlog: broken(['t1', 't2']),
        backlogAttempts: 3,
        backlogLastErrors: 2,
        backlogErrorSignature: 'something|else',
      });
      const svc = build(draft);
      await svc.ingestBacklog('run-1', broken(['t3', 't4']));
      expect(dispatch).toHaveBeenCalled();
      expect(draft.backlogAttempts).toBe(4);
    });

    /** Identical issues twice running is the only thing that means stuck. */
    it('stops when exactly the same issues come back', async () => {
      const backlog = broken(['t1', 't2']);
      const first = makeDraft({ backlog, backlogAttempts: 1 });
      const svc = build(first);
      await svc.ingestBacklog('run-1', backlog);
      const signature = first.backlogErrorSignature;
      expect(signature).not.toBe('');

      draft = makeDraft({ backlog, backlogAttempts: 2, backlogErrorSignature: signature });
      const again = build(draft);
      await again.ingestBacklog('run-1', backlog);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('says why it stopped, instead of landing silently', async () => {
      const backlog = broken(['t1']);
      const first = makeDraft({ backlog, backlogAttempts: 1 });
      await build(first).ingestBacklog('run-1', backlog);

      draft = makeDraft({
        backlog,
        backlogAttempts: 2,
        backlogErrorSignature: first.backlogErrorSignature,
      });
      await build(draft).ingestBacklog('run-1', backlog);
      expect(draft.runNote).toMatch(/same ones/i);
    });

    /** The budget has to be reachable, which is the whole point. */
    it('keeps going past the third round while progress is being made', async () => {
      draft = makeDraft({
        backlog: broken(['t1']),
        backlogAttempts: 5,
        backlogLastErrors: 1,
        backlogErrorSignature: 'older|issues',
      });
      const svc = build(draft);
      await svc.ingestBacklog('run-1', broken(['t9']));
      expect(dispatch).toHaveBeenCalled();
      expect(draft.backlogAttempts).toBe(6);
    });
  });

  describe('when a correction patch arrives', () => {
    beforeEach(async () => {
      draft = makeDraft({
        backlog: clean(),
        planFeedback: 'Fix exactly these: ...',
        backlogLastErrors: 1,
      });
      service = build(draft);
      // The patch fills in the one thing that was missing.
      await service.ingestBacklog('run-1', [
        { id: 'e1-f1-s1-t1', acceptanceCriteria: '- Now checkable' } as BacklogItem,
      ]);
    });

    it('merges the patch into the draft', () => {
      expect(draft.backlog).toHaveLength(4);
      expect(draft.backlog.find((i) => i.id === 'e1-f1-s1-t1')?.acceptanceCriteria).toBe(
        '- Now checkable',
      );
    });

    /** The bug: the patch has no title, so validating it invented eleven title errors. */
    it('does not report the patched items as missing a title', () => {
      expect(draft.planFeedback ?? '').not.toContain('Title is required');
    });

    it('accepts the corrected backlog instead of asking for another round', () => {
      expect(draft.status).toBe(DraftStatus.BacklogDrafted);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  /**
   * The other half of the same bug: problems the patch did not touch must still be seen. Validating
   * the payload hid them, so the agent was never asked about the work that actually remained.
   */
  it('still reports problems the patch did not touch', async () => {
    const backlog = clean();
    backlog[2] = { ...backlog[2], acceptanceCriteria: '' } as BacklogItem; // Story with no criteria
    draft = makeDraft({ backlog, planFeedback: 'Fix exactly these: ...', backlogLastErrors: 9 });
    service = build(draft);

    await service.ingestBacklog('run-1', [
      { id: 'e1-f1-s1-t1', acceptanceCriteria: '- Now checkable' } as BacklogItem,
    ]);

    expect(draft.planFeedback).toContain('e1-f1-s1');
    expect(draft.status).toBe(DraftStatus.BacklogDrafting);
    expect(dispatch).toHaveBeenCalled();
  });

  /** A first draft replaces rather than merges, and is validated as the whole thing it is. */
  it('validates the whole backlog on a first draft', async () => {
    draft = makeDraft({ backlog: [], planFeedback: null });
    service = build(draft);

    await service.ingestBacklog('run-1', clean());

    expect(draft.backlog).toHaveLength(4);
    expect(draft.status).toBe(DraftStatus.BacklogDrafted);
  });
});

/**
 * When the orchestrator stops asking the Scrum Master to fix the backlog.
 *
 * It used to compare the *number* of blocking issues and stop as soon as a round failed to reduce
 * it. That reads as reasonable and is not: the Scrum Master fixes several items a round and
 * routinely trips a different rule doing it — moving a Task's sprint can breach a dependency — so
 * a round that genuinely made progress came back with the same total and was judged stuck. The
 * first two rounds were waved through unconditionally, so the check only bit on the third, and
 * **every product stopped at exactly two attempts out of a budget of eight**. Two separate
 * products were handed to a person with blocking issues the loop had the budget to fix.
 *
 * What "stuck" actually means is that the same issues came back, which is what it now compares.
 */
describe('PlanningService.errorSignature', () => {
  const issue = (itemId: string | null, message: string) =>
    ({ itemId, severity: 'error', message }) as never;

  it('is the same for the same issues', () => {
    const a = PlanningService.errorSignature([issue('t1', 'bad repo'), issue('t2', 'bad sprint')]);
    const b = PlanningService.errorSignature([issue('t1', 'bad repo'), issue('t2', 'bad sprint')]);
    expect(a).toBe(b);
  });

  /** The validator's ordering is an implementation detail; the same problems must look the same. */
  it('ignores the order they were reported in', () => {
    const a = PlanningService.errorSignature([issue('t1', 'bad repo'), issue('t2', 'bad sprint')]);
    const b = PlanningService.errorSignature([issue('t2', 'bad sprint'), issue('t1', 'bad repo')]);
    expect(a).toBe(b);
  });

  /** The case the count missed: as many issues as before, but different ones. */
  it('differs when the same number of different issues come back', () => {
    const before = PlanningService.errorSignature([issue('t1', 'bad repo'), issue('t2', 'x')]);
    const after = PlanningService.errorSignature([issue('t3', 'bad sprint'), issue('t4', 'y')]);
    expect(after).not.toBe(before);
  });

  it('differs when the same item has a different problem', () => {
    const before = PlanningService.errorSignature([issue('t1', 'bad repo')]);
    const after = PlanningService.errorSignature([issue('t1', 'bad sprint')]);
    expect(after).not.toBe(before);
  });

  it('tells project-level issues apart from item ones', () => {
    expect(PlanningService.errorSignature([issue(null, 'same')])).not.toBe(
      PlanningService.errorSignature([issue('t1', 'same')]),
    );
  });

  it('is empty when there is nothing wrong', () => {
    expect(PlanningService.errorSignature([])).toBe('');
  });
});

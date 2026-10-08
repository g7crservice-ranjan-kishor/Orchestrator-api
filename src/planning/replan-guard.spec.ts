import { PlanningService } from './planning.service';
import { BacklogItem, BacklogItemType, DraftDocument } from './schemas/draft.schema';

/**
 * Re-planning a project whose work is already in Azure DevOps takes it apart.
 *
 * The path looks harmless — submit a new requirement, press **Start EM planning** — and it is
 * anything but. A fresh Scrum Master run *replaces* `draft.backlog` outright (merging happens only
 * for corrections), so every item's `adoId` is lost. The work items stay in Azure DevOps with
 * nothing pointing at them: the board cannot find them, no commit can be traced to a Task, and the
 * dependency lookup that reads `adoId` to work out what a Task is waiting for goes blind.
 *
 * On the Employee Management System that would have orphaned 54 work items, 30 of them already
 * built, in one click.
 *
 * The count is what the refusal is built on, so it is what this pins.
 */

const item = (over: Partial<BacklogItem> & { id: string }): BacklogItem =>
  ({
    type: BacklogItemType.Task,
    title: over.id,
    parentId: null,
    repo: null,
    sprint: 'Sprint 1',
    dependsOn: [],
    adoId: null,
    ...over,
  }) as BacklogItem;

const draftWith = (backlog: BacklogItem[]) => ({ backlog }) as DraftDocument;

describe('PlanningService.pushedItemCount', () => {
  it('counts nothing for a plan that has never been pushed', () => {
    const draft = draftWith([item({ id: 'a' }), item({ id: 'b' })]);
    expect(PlanningService.pushedItemCount(draft)).toBe(0);
  });

  it('counts the items that exist in Azure DevOps', () => {
    const draft = draftWith([
      item({ id: 'a', adoId: 730 }),
      item({ id: 'b' }),
      item({ id: 'c', adoId: 731 }),
    ]);
    expect(PlanningService.pushedItemCount(draft)).toBe(2);
  });

  it('counts an empty backlog as nothing', () => {
    expect(PlanningService.pushedItemCount(draftWith([]))).toBe(0);
  });

  /** A partially pushed plan is still a plan with something to lose. */
  it('counts a single pushed item', () => {
    expect(PlanningService.pushedItemCount(draftWith([item({ id: 'a', adoId: 1 })]))).toBe(1);
  });
});

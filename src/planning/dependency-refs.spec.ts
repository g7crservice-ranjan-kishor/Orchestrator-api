import {
  blockingWorkItemIds,
  dependencyTargets,
  externalWorkItemId,
  isExternalRef,
} from './dependency-refs';
import { BacklogItem, BacklogItemType } from './schemas/draft.schema';

/**
 * A new task has to be able to wait for an old one.
 *
 * "Add a dark mode toggle to the Settings page" depends on **Build the Settings page** — which
 * belongs to the original plan, was pushed to Azure DevOps already, and may still be sitting in
 * To Do. Without a way to say that, the enhancement Task is dispatched, the agent opens the code,
 * finds no Settings page, and either fails or builds a second one beside the one the original plan
 * was going to build.
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

const index = (items: BacklogItem[]) => new Map(items.map((i) => [i.id, i]));

describe('externalWorkItemId', () => {
  it('reads a work item written the way a person writes it', () => {
    expect(externalWorkItemId('#790')).toBe(790);
    expect(externalWorkItemId('790')).toBe(790);
    expect(externalWorkItemId('  #790  ')).toBe(790);
    expect(externalWorkItemId('AB#790')).toBe(790);
  });

  /** A draft id is words and dashes; nothing can be both, so nothing is ambiguous. */
  it('does not mistake a draft id for a work item', () => {
    expect(externalWorkItemId('story-2-1-3')).toBeNull();
    expect(externalWorkItemId('task-2-1-2-1')).toBeNull();
    expect(isExternalRef('story-2-1-3')).toBe(false);
    expect(isExternalRef('#790')).toBe(true);
  });

  it('refuses nonsense', () => {
    expect(externalWorkItemId('')).toBeNull();
    expect(externalWorkItemId('#')).toBeNull();
    expect(externalWorkItemId('#0')).toBeNull();
    expect(externalWorkItemId('#-5')).toBeNull();
    expect(externalWorkItemId('790px')).toBeNull();
  });
});

describe('dependencyTargets', () => {
  it('separates items in this backlog from work items outside it', () => {
    const settings = item({ id: 'story-settings', adoId: 790 });
    const toggle = item({ id: 'task-toggle', dependsOn: ['story-settings', '#812'] });
    const targets = dependencyTargets(toggle, index([settings, toggle]));

    expect(targets.items.map((i) => i.id)).toEqual(['story-settings']);
    expect(targets.workItemIds).toEqual([812]);
    expect(targets.unknown).toEqual([]);
  });

  /** A dependency nobody can resolve is a rule that will never be enforced — it is reported. */
  it('reports an entry that names neither', () => {
    const orphan = item({ id: 'task-x', dependsOn: ['story-that-was-deleted'] });
    expect(dependencyTargets(orphan, index([orphan])).unknown).toEqual(['story-that-was-deleted']);
  });

  it('says nothing for an item with no dependencies', () => {
    const plain = item({ id: 'task-x' });
    expect(dependencyTargets(plain, index([plain]))).toEqual({
      items: [],
      workItemIds: [],
      unknown: [],
    });
  });
});

describe('blockingWorkItemIds', () => {
  /** The whole point: an enhancement Task waits for a Task from the original plan. */
  it('waits for a work item named directly', () => {
    const toggle = item({ id: 'task-toggle', dependsOn: ['#790'] });
    expect(blockingWorkItemIds(toggle, index([toggle]))).toEqual([790]);
  });

  it('waits for a backlog item under the id it was pushed as', () => {
    const settings = item({ id: 'story-settings', adoId: 790 });
    const toggle = item({ id: 'task-toggle', dependsOn: ['story-settings'] });
    expect(blockingWorkItemIds(toggle, index([settings, toggle]))).toEqual([790]);
  });

  /**
   * An item being created in the same push has no id yet, so there is nothing to wait on. The
   * sprint-ordering rules already cover two items drafted together.
   */
  it('ignores a dependency that has not been pushed yet', () => {
    const unpushed = item({ id: 'story-new', adoId: null });
    const toggle = item({ id: 'task-toggle', dependsOn: ['story-new'] });
    expect(blockingWorkItemIds(toggle, index([unpushed, toggle]))).toEqual([]);
  });

  it('counts a work item once however many ways it is named', () => {
    const settings = item({ id: 'story-settings', adoId: 790 });
    const toggle = item({ id: 'task-toggle', dependsOn: ['story-settings', '#790', '790'] });
    expect(blockingWorkItemIds(toggle, index([settings, toggle]))).toEqual([790]);
  });
});

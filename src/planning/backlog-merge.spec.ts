import { mergeBacklog, storiesMissingCriteria } from './backlog-merge';
import { BacklogItem, BacklogItemType } from './schemas/draft.schema';

function item(over: Partial<BacklogItem> & Pick<BacklogItem, 'id' | 'type'>): BacklogItem {
  return {
    title: over.id.toUpperCase(),
    description: '',
    acceptanceCriteria: '',
    parentId: null,
    order: 0,
    priority: 2,
    estimate: null,
    dependsOn: [],
    repo: null,
    sprint: null,
    attachments: [],
    adoId: null,
    ...over,
  } as BacklogItem;
}

/**
 * Why a correction is merged rather than substituted.
 *
 * Asking the Scrum Master to re-output a whole 120-item backlog to fix one field did not work: it
 * held the structure or the detail, never both. One correction wrote every sprint and lost all 28
 * Tasks; the next restored the Tasks and lost the sprints. Merging makes that impossible — a
 * correction can add what is missing, and cannot drop what was already right.
 */
describe('mergeBacklog', () => {
  const existing = [
    item({ id: 'epic-1', type: BacklogItemType.Epic, repo: 'api', sprint: 'Sprint 1' }),
    item({ id: 'feat-1', type: BacklogItemType.Feature, parentId: 'epic-1', repo: 'api' }),
    item({
      id: 'story-1',
      type: BacklogItemType.Story,
      parentId: 'feat-1',
      repo: 'api',
      sprint: 'Sprint 1',
    }),
    item({ id: 'task-1', type: BacklogItemType.Task, parentId: 'story-1', repo: 'api' }),
  ];

  it('fills in the field a correction supplies', () => {
    const merged = mergeBacklog(existing, [
      item({ id: 'story-1', type: BacklogItemType.Story, acceptanceCriteria: '- It works' }),
    ]);
    expect(merged.find((i) => i.id === 'story-1')?.acceptanceCriteria).toBe('- It works');
  });

  /** The property that matters: silence is not deletion. */
  it('keeps every field the correction does not mention', () => {
    const merged = mergeBacklog(existing, [
      item({ id: 'story-1', type: BacklogItemType.Story, acceptanceCriteria: '- It works' }),
    ]);
    const story = merged.find((i) => i.id === 'story-1')!;
    expect(story.repo).toBe('api');
    expect(story.sprint).toBe('Sprint 1');
    expect(story.title).toBe('STORY-1');
  });

  it('keeps every item the correction does not mention', () => {
    const merged = mergeBacklog(existing, [
      item({ id: 'story-1', type: BacklogItemType.Story, acceptanceCriteria: '- It works' }),
    ]);
    expect(merged.map((i) => i.id)).toEqual(['epic-1', 'feat-1', 'story-1', 'task-1']);
  });

  /** A blank string is the agent omitting the field, not clearing it. */
  it('does not let an empty value wipe an existing one', () => {
    const merged = mergeBacklog(existing, [
      item({ id: 'story-1', type: BacklogItemType.Story, repo: '', sprint: '   ' }),
    ]);
    const story = merged.find((i) => i.id === 'story-1')!;
    expect(story.repo).toBe('api');
    expect(story.sprint).toBe('Sprint 1');
  });

  describe('new items', () => {
    it('adds a Task the correction introduces', () => {
      const merged = mergeBacklog(existing, [
        item({ id: 'task-2', type: BacklogItemType.Task, parentId: 'story-1', repo: 'api' }),
      ]);
      expect(merged).toHaveLength(5);
      expect(merged.find((i) => i.id === 'task-2')).toBeDefined();
    });

    /** Ordering is the build order, so a new Task belongs with its parent, not at the end. */
    it('places it under its parent rather than appending it', () => {
      const merged = mergeBacklog(
        [...existing, item({ id: 'epic-2', type: BacklogItemType.Epic })],
        [item({ id: 'task-2', type: BacklogItemType.Task, parentId: 'story-1' })],
      );
      expect(merged.map((i) => i.id)).toEqual([
        'epic-1',
        'feat-1',
        'story-1',
        'task-1',
        'task-2',
        'epic-2',
      ]);
    });

    it('falls back to the end when the parent is unknown', () => {
      const merged = mergeBacklog(existing, [
        item({ id: 'orphan', type: BacklogItemType.Task, parentId: 'nowhere' }),
      ]);
      expect(merged[merged.length - 1].id).toBe('orphan');
    });
  });

  it('takes the correction wholesale when there is nothing to merge into', () => {
    const fresh = [item({ id: 'a', type: BacklogItemType.Epic })];
    expect(mergeBacklog([], fresh)).toEqual(fresh);
  });

  it('changes nothing when the correction is empty', () => {
    expect(mergeBacklog(existing, []).map((i) => i.id)).toEqual([
      'epic-1',
      'feat-1',
      'story-1',
      'task-1',
    ]);
  });

  /** The exact regression: a correction that only writes sprints must not cost the Tasks. */
  it('cannot lose the Tasks while fixing the sprints', () => {
    const merged = mergeBacklog(existing, [
      item({ id: 'epic-1', type: BacklogItemType.Epic, sprint: 'Sprint 2' }),
      item({ id: 'story-1', type: BacklogItemType.Story, sprint: 'Sprint 2' }),
    ]);
    expect(merged.filter((i) => i.type === BacklogItemType.Task)).toHaveLength(1);
    expect(merged.find((i) => i.id === 'epic-1')?.sprint).toBe('Sprint 2');
  });
  /**
   * A correction is `{ id, acceptanceCriteria }` — no type, no title. Those must update an
   * existing item, and must never create a typeless row when the id is unknown.
   */
  describe('patch-shaped corrections', () => {
    it('applies a patch that carries neither type nor title', () => {
      const patch = { id: 'story-1', acceptanceCriteria: '- Checks out' } as BacklogItem;
      const merged = mergeBacklog(existing, [patch]);
      const story = merged.find((i) => i.id === 'story-1')!;
      expect(story.acceptanceCriteria).toBe('- Checks out');
      expect(story.type).toBe(BacklogItemType.Story);
      expect(story.title).toBe('STORY-1');
      expect(merged).toHaveLength(4);
    });

    it('ignores a patch aimed at an id that does not exist', () => {
      const orphan = { id: 'nope', acceptanceCriteria: '- x' } as BacklogItem;
      expect(mergeBacklog(existing, [orphan])).toHaveLength(4);
    });

    it('still adds a new item when the correction gives it a type and title', () => {
      const created = item({
        id: 'task-9',
        type: BacklogItemType.Task,
        title: 'New task',
        parentId: 'story-1',
      });
      expect(mergeBacklog(existing, [created]).map((i) => i.id)).toContain('task-9');
    });
  });
});

describe('storiesMissingCriteria', () => {
  it('names only the Stories still without criteria', () => {
    const items = [
      item({ id: 's1', type: BacklogItemType.Story, acceptanceCriteria: '- done' }),
      item({ id: 's2', type: BacklogItemType.Story }),
      item({ id: 's3', type: BacklogItemType.Story, acceptanceCriteria: '   ' }),
      item({ id: 't1', type: BacklogItemType.Task }),
    ];
    expect(storiesMissingCriteria(items).map((i) => i.id)).toEqual(['s2', 's3']);
  });
});

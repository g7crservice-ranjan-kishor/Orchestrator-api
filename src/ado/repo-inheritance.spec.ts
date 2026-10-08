import { inheritedRepo, storiesWithoutRepo } from './repo-inheritance';
import { BacklogItem, BacklogItemType } from '../planning/schemas/draft.schema';

/**
 * A Story that spans repositories could never be tested.
 *
 * QA tests Stories and resolves the repository to clone from the work item's `repo:` tag. A Story
 * whose Tasks live in *different* repositories has no repository of its own, so the Scrum Master
 * leaves `repo` empty and the push wrote no tag — and QA then rejected the Story with "no target
 * repository resolvable for the work item". Because the QA queue stopped when a Story could not
 * start, one untagged Story paused the eighteen behind it.
 *
 * These are the real three from the Employee Management System backlog, which were exactly the
 * three that span both repositories — including the browser end-to-end journey, the one Story that
 * exists to catch defects *between* the two applications.
 */

const API = 'employee-management-system-api';
const UI = 'employee-management-system-ui';

const item = (over: Partial<BacklogItem> & { id: string; type: BacklogItemType }): BacklogItem =>
  ({
    title: over.id,
    parentId: null,
    repo: null,
    sprint: 'Sprint 1',
    ...over,
  }) as BacklogItem;

const story = (id: string, repo: string | null = null, parentId: string | null = null) =>
  item({ id, type: BacklogItemType.Story, repo, parentId });

const task = (id: string, parentId: string, repo: string | null) =>
  item({ id, type: BacklogItemType.Task, parentId, repo });

describe('inheritedRepo', () => {
  it('keeps the repository an item already names', () => {
    const backlog = [story('s1', UI), task('t1', 's1', API)];
    expect(inheritedRepo(backlog[0], backlog)).toBe(UI);
  });

  /** The failure this exists for. */
  it('gives a Story spanning both repositories the first of them', () => {
    const backlog = [
      story('story-2-2-1'),
      task('t-api', 'story-2-2-1', API),
      task('t-ui', 'story-2-2-1', UI),
    ];
    expect(inheritedRepo(backlog[0], backlog)).toBe(API);
  });

  it('reads the repository in backlog order, not by branch depth', () => {
    const backlog = [story('s1'), task('t-ui', 's1', UI), task('t-api', 's1', API)];
    expect(inheritedRepo(backlog[0], backlog)).toBe(UI);
  });

  it('looks past a child that names none', () => {
    const backlog = [story('s1'), task('t0', 's1', null), task('t1', 's1', API)];
    expect(inheritedRepo(backlog[0], backlog)).toBe(API);
  });

  it('reaches a grandchild when the children name none', () => {
    const backlog = [story('s1'), task('t1', 's1', null), task('t2', 't1', UI)];
    expect(inheritedRepo(backlog[0], backlog)).toBe(UI);
  });

  it('says nothing when no descendant names a repository', () => {
    const backlog = [story('s1'), task('t1', 's1', null)];
    expect(inheritedRepo(backlog[0], backlog)).toBeNull();
  });

  it('says nothing for a Story with no children at all', () => {
    const backlog = [story('s1')];
    expect(inheritedRepo(backlog[0], backlog)).toBeNull();
  });

  /**
   * Only Stories inherit. A Task without a repository is a planning error the backlog gates already
   * report, and quietly giving it a sibling's repository would commit work to the wrong place.
   */
  it('does not give a Task a repository it was not assigned', () => {
    const backlog = [story('s1', API), task('t1', 's1', null)];
    expect(inheritedRepo(backlog[1], backlog)).toBeNull();
  });

  it('does not tag an Epic or a Feature', () => {
    const epic = item({ id: 'e1', type: BacklogItemType.Epic });
    const feature = item({ id: 'f1', type: BacklogItemType.Feature, parentId: 'e1' });
    const backlog = [epic, feature, task('t1', 'f1', API)];
    expect(inheritedRepo(epic, backlog)).toBeNull();
    expect(inheritedRepo(feature, backlog)).toBeNull();
  });

  /** A malformed backlog must not hang the push. */
  it('survives a cycle in the parent links', () => {
    const a = item({ id: 'a', type: BacklogItemType.Story, parentId: 'b' });
    const b = item({ id: 'b', type: BacklogItemType.Task, parentId: 'a' });
    expect(inheritedRepo(a, [a, b])).toBeNull();
  });
});

describe('storiesWithoutRepo', () => {
  it('names the Stories that would still reach Azure DevOps untagged', () => {
    const backlog = [
      story('tagged', API),
      story('spans'),
      task('t1', 'spans', UI),
      story('orphan'),
    ];
    expect(storiesWithoutRepo(backlog).map((i) => i.id)).toEqual(['orphan']);
  });
});

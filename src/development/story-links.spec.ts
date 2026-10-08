import {
  AdoRelation,
  CHILD_REL,
  childCandidates,
  childIds,
  PARENT_REL,
  parentIds,
  relatedIdOf,
  relatedIds,
  storyCandidates,
} from './story-links';

/**
 * The fix→retest loop broke for 4 of 14 Bugs, and nothing said so.
 *
 * QA was told to link a Bug to its Story "(parent/related)". For Bugs 814, 816, 825 and 858 it used
 * a **Related** link — exactly what it had been allowed to do. Every piece of code that looks for a
 * Bug's Story reads `System.Parent`, so those four belonged to no Story at all. Story 740 sat in
 * `Committed` with its Bug fixed and Done, waiting for a re-test nothing would ever request.
 */

const rel = (relation: string, id: number): AdoRelation => ({
  rel: relation,
  url: `https://dev.azure.com/org/P/_apis/wit/workItems/${id}`,
});

const parent = (id: number) => rel(PARENT_REL, id);
const child = (id: number) => rel(CHILD_REL, id);
const related = (id: number) => rel('System.LinkTypes.Related', id);

describe('relatedIdOf', () => {
  it('reads the id off the end of the url', () => {
    expect(relatedIdOf(parent(740))).toBe(740);
  });

  it('refuses a url with no id on the end', () => {
    expect(relatedIdOf({ rel: PARENT_REL, url: '' })).toBeNull();
    expect(relatedIdOf({ rel: PARENT_REL, url: '…/workItems/none' })).toBeNull();
  });
});

describe('reading one kind of link', () => {
  const relations = [parent(740), child(768), related(812), related(812)];

  it('separates parents, children and related', () => {
    expect(parentIds(relations)).toEqual([740]);
    expect(childIds(relations)).toEqual([768]);
    expect(relatedIds(relations)).toEqual([812]);
  });

  it('says nothing for an item with no links at all', () => {
    expect(parentIds([])).toEqual([]);
    expect(storyCandidates([])).toEqual([]);
  });

  /** Azure DevOps writes this one as `System.LinkTypes.Related`, with variants. */
  it('recognises a Related link however it is spelled', () => {
    expect(relatedIds([rel('System.LinkTypes.Related-Forward', 9)])).toEqual([9]);
    expect(relatedIds([rel('system.linktypes.related', 9)])).toEqual([9]);
  });
});

describe('storyCandidates', () => {
  it('uses the parent when there is one', () => {
    expect(storyCandidates([parent(735), related(999)])).toEqual([735]);
  });

  /** The four real Bugs. Without this they belong to no Story and the loop never closes. */
  it('falls back to a Related link when there is no parent', () => {
    expect(storyCandidates([related(740)])).toEqual([740]);
  });

  /**
   * A correctly filed Bug must never be re-pointed by a stray Related link — a Bug is often related
   * to several Stories while belonging to exactly one.
   */
  it('never lets a Related link override a real parent', () => {
    expect(storyCandidates([related(1), related(2), parent(735)])).toEqual([735]);
  });
});

describe('childCandidates', () => {
  it('counts the Story’s own children', () => {
    expect(childCandidates([child(768), child(769)])).toEqual([768, 769]);
  });

  /** An open Bug linked the other way still means the Story is not finished. */
  it('counts a merely related Bug too', () => {
    expect(childCandidates([child(768), related(814)])).toEqual([768, 814]);
  });

  it('counts a work item once when it is linked both ways', () => {
    expect(childCandidates([child(768), related(768)])).toEqual([768]);
  });
});

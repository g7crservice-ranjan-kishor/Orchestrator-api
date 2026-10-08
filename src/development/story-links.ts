/**
 * Finding the Story a Bug belongs to, whichever way QA linked it.
 *
 * **The failure this exists for.** QA files a Bug and links it to the Story it was found in. The
 * roll-up then watches that Story: once its Tasks are Done and its Bugs are closed, the Story goes
 * back to `Done`, which is the Ready-for-QA signal that gets the fix re-tested.
 *
 * That loop silently broke for 4 of 14 Bugs on the Employee Management System. The QA prompt said
 * to link a Bug to its Story "(parent/related)" — so the agent used a **Related** link, which is
 * exactly what it was told it could do. Every piece of code that looks for a Bug's Story reads
 * `System.Parent` and nothing else, so those four Bugs belonged to no Story as far as the
 * orchestrator was concerned. Story 740 sat in `Committed` with its Bug fixed and Done, waiting for
 * a re-test that nothing would ever ask for.
 *
 * Two things follow. The prompt is tightened to require a parent link — and, because a prompt is a
 * request rather than a guarantee, the code accepts a Related link too. The instruction stops it
 * recurring; this is what makes it not matter when it does.
 */

/** One Azure DevOps work-item relation, as the API returns it. */
export interface AdoRelation {
  rel: string;
  url: string;
}

/** `…/_apis/wit/workItems/814` → `814`. */
export function relatedIdOf(relation: AdoRelation): number | null {
  const tail = (relation?.url ?? '').split('/').filter(Boolean).pop();
  const id = Number(tail);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The parent link: this item hangs off that one. */
export const PARENT_REL = 'System.LinkTypes.Hierarchy-Reverse';
/** The child link: that item hangs off this one. */
export const CHILD_REL = 'System.LinkTypes.Hierarchy-Forward';

function idsFor(relations: AdoRelation[], matches: (rel: string) => boolean): number[] {
  return [
    ...new Set(
      (relations ?? [])
        .filter((relation) => matches(relation?.rel ?? ''))
        .map(relatedIdOf)
        .filter((id): id is number => id !== null),
    ),
  ];
}

/** Every "Related" link, whatever casing or suffix Azure DevOps uses for it. */
export function relatedIds(relations: AdoRelation[]): number[] {
  return idsFor(relations, (rel) => rel.toLowerCase().includes('related'));
}

export function parentIds(relations: AdoRelation[]): number[] {
  return idsFor(relations, (rel) => rel === PARENT_REL);
}

export function childIds(relations: AdoRelation[]): number[] {
  return idsFor(relations, (rel) => rel === CHILD_REL);
}

/**
 * Work items that could be this one's Story, best first.
 *
 * A real parent link wins — it is what the hierarchy means, and a Bug may well be *related* to
 * several Stories while belonging to one. A Related link is only consulted when there is no parent,
 * so this can never override a correctly filed Bug; it only rescues one that was linked the other
 * way the prompt allowed.
 */
export function storyCandidates(relations: AdoRelation[]): number[] {
  const parents = parentIds(relations);
  return parents.length > 0 ? parents : relatedIds(relations);
}

/**
 * Work items that should be judged as the Story's own, best first.
 *
 * Its children — Tasks, and Bugs filed properly — plus anything merely related, because a Bug
 * linked that way is still a Bug against this Story and an open one still means it is not finished.
 */
export function childCandidates(relations: AdoRelation[]): number[] {
  return [...new Set([...childIds(relations), ...relatedIds(relations)])];
}

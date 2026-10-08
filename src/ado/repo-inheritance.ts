import { BacklogItem, BacklogItemType } from '../planning/schemas/draft.schema';

/**
 * The repository a backlog item's `repo:` tag should name when the item does not name one itself.
 *
 * **The failure this exists for.** A Story whose Tasks live in *different* repositories has no
 * single repository, so the Scrum Master correctly leaves its `repo` empty — and the push then
 * writes no `repo:` tag at all. QA tests Stories and resolves the repository to clone from exactly
 * that tag, so on a two-repository product those Stories were rejected with "no target repository
 * resolvable for the work item", and because the QA queue stops when a Story cannot start, one
 * untagged Story paused the eighteen behind it.
 *
 * On the Employee Management System it was 3 Stories out of 25, and they were precisely the three
 * that span both repositories — including **the browser end-to-end journey**, the one Story that
 * exists to catch defects *between* the two applications.
 *
 * **Why the first child's repository is the right answer.** It is a starting point, not a claim
 * about where the Story lives. A QA run already clones every *other* repository of the project as a
 * companion (`buildRunContext`'s `companionRepos`), precisely so a cross-application journey can be
 * tested; all the tag has to do is give the pod somewhere to start. Leaving it empty, by contrast,
 * means the Story can never run at all.
 */
export function inheritedRepo(item: BacklogItem, backlog: BacklogItem[]): string | null {
  if (item.repo) return item.repo;

  // Only Stories need this. A Task always carries its own repository (it is the unit of developer
  // work, and a Task without one is a planning error the backlog gates already report), and an Epic
  // or Feature is never executed by anything.
  if (item.type !== BacklogItemType.Story) return null;

  const children = new Map<string, BacklogItem[]>();
  for (const candidate of backlog) {
    if (!candidate.parentId) continue;
    const siblings = children.get(candidate.parentId) ?? [];
    siblings.push(candidate);
    children.set(candidate.parentId, siblings);
  }

  // Breadth-first in backlog order, so the answer is the first repository a reader would see under
  // the Story rather than whichever branch happens to be deepest.
  const queue = [...(children.get(item.id) ?? [])];
  const seen = new Set<string>([item.id]);
  while (queue.length > 0) {
    const next = queue.shift() as BacklogItem;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    if (next.repo) return next.repo;
    queue.push(...(children.get(next.id) ?? []));
  }
  return null;
}

/**
 * Every Story that would reach Azure DevOps with no `repo:` tag at all.
 *
 * Reported rather than thrown: a Story with no descendants carrying a repository is a planning
 * problem, not a push problem, and the push must still create the rest of the backlog.
 */
export function storiesWithoutRepo(backlog: BacklogItem[]): BacklogItem[] {
  return backlog.filter(
    (item) => item.type === BacklogItemType.Story && !inheritedRepo(item, backlog),
  );
}

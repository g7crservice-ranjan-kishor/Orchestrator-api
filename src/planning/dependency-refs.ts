import { BacklogItem } from './schemas/draft.schema';

/**
 * What one entry in a backlog item's `dependsOn` points at.
 *
 * Until enhancements existed, every dependency was another item in the same backlog, named by its
 * draft id (`story-2-1-3`). An enhancement breaks that assumption: "add a dark mode toggle to the
 * Settings page" depends on **Build the Settings page**, which belongs to the original plan, was
 * pushed to Azure DevOps weeks ago, and may not be built yet.
 *
 * So a dependency may also name an Azure DevOps work item outright — `#790` or `790`. The two are
 * told apart by shape: a draft id is always words and dashes (`task-2-1-2-1`), a work item is
 * always digits. Nothing can be both, so nothing is ambiguous.
 *
 * This matters because of what the queue does with it. A new Task whose dependency is not finished
 * is **skipped** until it is — otherwise the agent opens the code, finds no Settings page, and
 * either fails or builds a second one beside the one the original plan was going to build.
 */

/** `#790`, `790` or `AB#790` → `790`. Anything else → null. */
export function externalWorkItemId(ref: string): number | null {
  const trimmed = (ref ?? '').trim();
  const match = /^(?:[A-Za-z]{0,4}#)?(\d+)$/.exec(trimmed);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Whether a `dependsOn` entry names an Azure DevOps work item rather than a draft item. */
export function isExternalRef(ref: string): boolean {
  return externalWorkItemId(ref) !== null;
}

export interface DependencyTargets {
  /** Dependencies on items in this same backlog. */
  items: BacklogItem[];
  /** Dependencies on Azure DevOps work items outside this backlog. */
  workItemIds: number[];
  /** Entries that name neither — a typo, or an item that was deleted. */
  unknown: string[];
}

/**
 * Splits an item's `dependsOn` into what it actually points at.
 *
 * `byId` is this backlog's items by draft id. An entry that matches none of them and is not a work
 * item number is reported as unknown rather than silently dropped: a dependency nobody can resolve
 * is a scheduling rule that will never be enforced, and the backlog gate says so.
 */
export function dependencyTargets(
  item: BacklogItem,
  byId: Map<string, BacklogItem>,
): DependencyTargets {
  const targets: DependencyTargets = { items: [], workItemIds: [], unknown: [] };
  for (const ref of item.dependsOn ?? []) {
    const own = byId.get(ref);
    if (own) {
      targets.items.push(own);
      continue;
    }
    const external = externalWorkItemId(ref);
    if (external !== null) {
      targets.workItemIds.push(external);
      continue;
    }
    targets.unknown.push(ref);
  }
  return targets;
}

/**
 * Every Azure DevOps work item this item must wait for, as ids.
 *
 * Both kinds resolve to the same thing in the end: an item in this backlog contributes the id it
 * was pushed under, and an external reference contributes itself. An item in this backlog that has
 * not been pushed yet contributes nothing — it has no id to wait on, and the sprint-ordering rules
 * already cover the case where both are being created together.
 */
export function blockingWorkItemIds(item: BacklogItem, byId: Map<string, BacklogItem>): number[] {
  const targets = dependencyTargets(item, byId);
  const fromBacklog = targets.items
    .map((dependency) => dependency.adoId)
    .filter((id): id is number => typeof id === 'number');
  return [...new Set([...fromBacklog, ...targets.workItemIds])];
}

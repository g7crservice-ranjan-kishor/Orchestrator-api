import { BacklogItem, BacklogItemType } from './schemas/draft.schema';

/** True when the value carries something; a blank string is treated as "not supplied". */
function given(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value === 'string' ? value.trim().length > 0 : true;
}

/**
 * Applies a correction to an existing backlog.
 *
 * Asking the Scrum Master to re-output a whole 120-item backlog to fix one field does not work: it
 * holds the structure in view *or* the detail, not both, so each correction silently dropped
 * whatever it was attending to least — one run wrote the sprints and lost every Task, the next did
 * the reverse. A correction is therefore merged rather than substituted:
 *
 * - an incoming item whose `id` already exists **updates only the fields it supplies**, so a field
 *   the agent omits this time keeps the value it already had;
 * - an incoming item with a new `id` is **inserted after its parent's existing children**, which
 *   keeps the foundation-first ordering the backlog already has rather than appending new Tasks to
 *   the very end;
 * - an existing item the correction does not mention is **kept untouched**.
 *
 * The consequence that matters: a correction can add what is missing but cannot destroy what was
 * already right.
 */
export function mergeBacklog(existing: BacklogItem[], incoming: BacklogItem[]): BacklogItem[] {
  if (existing.length === 0) return incoming;

  const byId = new Map(existing.map((item) => [item.id, item]));
  const updated = new Map<string, BacklogItem>();
  const added: BacklogItem[] = [];

  for (const patch of incoming) {
    const current = byId.get(patch.id);
    if (!current) {
      // A correction may only *create* an item that is complete enough to be one. A patch aimed at
      // an id that no longer exists would otherwise land as a typeless, titleless row.
      if (patch.type && patch.title?.trim()) added.push(patch);
      continue;
    }
    // Explicit rather than a loop over field names: the fields a correction may change are
    // a deliberate list, and the compiler should hold us to it.
    const merged: BacklogItem = { ...current };
    if (given(patch.title)) merged.title = patch.title;
    if (given(patch.description)) merged.description = patch.description;
    if (given(patch.acceptanceCriteria)) merged.acceptanceCriteria = patch.acceptanceCriteria;
    if (given(patch.repo)) merged.repo = patch.repo;
    if (given(patch.sprint)) merged.sprint = patch.sprint;
    if (given(patch.priority)) merged.priority = patch.priority;
    updated.set(patch.id, merged);
  }

  // Place each new item after its parent's LAST existing child, so added Tasks follow the Tasks
  // already there instead of jumping ahead of them — the array order is the build order.
  const newChildren = new Map<string, BacklogItem[]>();
  for (const child of added) {
    const key = child.parentId ?? '';
    newChildren.set(key, [...(newChildren.get(key) ?? []), child]);
  }
  const lastChildIndex = new Map<string, number>();
  existing.forEach((child, index) => {
    if (child.parentId) lastChildIndex.set(child.parentId, index);
  });

  const result: BacklogItem[] = [];
  const placed = new Set<string>();

  const appendChildrenOf = (parentId: string): void => {
    for (const child of newChildren.get(parentId) ?? []) {
      if (placed.has(child.id)) continue;
      placed.add(child.id);
      result.push(child);
      // A new item can itself be a parent of another new item.
      appendChildrenOf(child.id);
    }
  };

  existing.forEach((current, index) => {
    result.push(updated.get(current.id) ?? current);
    // A parent with no existing children takes its new ones immediately.
    if (!lastChildIndex.has(current.id)) appendChildrenOf(current.id);
    // Otherwise they follow the last child already in place.
    for (const [parentId, last] of lastChildIndex) {
      if (last === index) appendChildrenOf(parentId);
    }
  });

  // Anything whose parent is not in this backlog at all still belongs somewhere: the end.
  for (const child of added) {
    if (!placed.has(child.id)) {
      placed.add(child.id);
      result.push(child);
    }
  }
  return result;
}

/**
 * The Stories a correction still has to write criteria for, so the request names them rather than
 * asking for the whole backlog again.
 */
export function storiesMissingCriteria(items: BacklogItem[]): BacklogItem[] {
  return items.filter(
    (item) => item.type === BacklogItemType.Story && !item.acceptanceCriteria?.trim(),
  );
}

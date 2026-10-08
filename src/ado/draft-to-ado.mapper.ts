import { BacklogItem, BacklogItemType } from '../planning/schemas/draft.schema';
import { AdoPushContext, JsonPatchOperation } from './ado.types';

/**
 * Maps the framework backlog hierarchy to Azure DevOps Scrum work-item types
 * (ARCHITECTURE.md §8): Epic → Feature → Story(=Product Backlog Item) → Task.
 */
export function adoTypeFor(type: BacklogItemType): string {
  switch (type) {
    case BacklogItemType.Epic:
      return 'Epic';
    case BacklogItemType.Feature:
      return 'Feature';
    case BacklogItemType.Story:
      return 'Product Backlog Item';
    case BacklogItemType.Task:
      return 'Task';
  }
}

/** ADO Scrum priority is 1–4; clamp the draft priority into range (default 2). */
function clampPriority(priority: number): number {
  if (!Number.isFinite(priority)) return 2;
  return Math.min(4, Math.max(1, Math.trunc(priority)));
}

/**
 * Builds a valid ADO `System.IterationPath`. ADO requires a full path from the project root
 * (e.g. `NQAI-DevAutomation\Sprint 4`); a bare sprint leaf like "Sprint 4" is rejected with a 400.
 * A sprint that already contains a path separator is treated as a full path and used as-is; a bare
 * leaf is prefixed with the project. When no sprint is set, the configured default iteration path
 * (already a valid full path — the project root by default) is used unchanged.
 */
function iterationPathFor(item: BacklogItem, ctx: AdoPushContext): string {
  const written = item.sprint?.trim();
  if (!written) return ctx.defaultIterationPath ?? ctx.project;
  /*
   * An enhancement's relative sprint becomes the real one the orchestrator scheduled it into.
   *
   * A Scrum Master numbers from one, because it is planning a body of work rather than reading a
   * calendar. For a first build that is right. For an enhancement its "Sprint 1" is a sprint that
   * closed weeks ago, and a work item created there exists in Azure DevOps, is absent from the
   * board, and is picked up by nothing. An initial plan has no mapping and keeps what it wrote.
   */
  const sprint = ctx.sprintMapping?.get(written) ?? written;
  return sprint.includes('\\') ? sprint : `${ctx.project}\\${sprint}`;
}

/**
 * Defaults for fields the ADO Scrum process marks **alwaysRequired** but the draft does not carry.
 * Supplying valid values here lets a customized process (required Effort/Activity/Value Area/dates)
 * accept the create; they are ordinary work-item fields the team can refine in ADO afterwards.
 */
const REQUIRED_TEXT_FALLBACK = 'To be defined.';
const DEFAULT_EFFORT = 1; // Scrum PBI effort estimate (Microsoft.VSTS.Scheduling.Effort).
const DEFAULT_ACTIVITY = 'Development'; // Task activity — the draft's Tasks are development work.
const DEFAULT_VALUE_AREA = 'Business'; // Epics/Features/PBIs deliver business value by default.
const DEFAULT_DURATION_DAYS = 14; // Start→Target window when the draft has no explicit dates.

/** Start/Target dates (ISO 8601) for portfolio items that require them. Defaults to a 2-week window. */
function scheduleWindow(now: Date = new Date()): { start: string; target: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const target = new Date(start);
  target.setUTCDate(target.getUTCDate() + DEFAULT_DURATION_DAYS);
  return { start: start.toISOString(), target: target.toISOString() };
}

/**
 * Builds the JSON-Patch document to create one work item. `parentUrl` links the item to its
 * already-created parent (Hierarchy-Reverse); `assignedTo` is set for Tasks only. Pure and
 * fully unit-tested — no I/O.
 *
 * `repo` is the repository to tag the item with. It defaults to the item's own, and the push passes
 * one worked out from the item's children when the item has none — see `repo-inheritance.ts` for
 * why a Story that spans repositories must still carry a tag.
 */
export function buildCreatePatch(
  item: BacklogItem,
  ctx: AdoPushContext,
  parentUrl: string | null,
  repo: string | null = null,
): JsonPatchOperation[] {
  const ops: JsonPatchOperation[] = [
    { op: 'add', path: '/fields/System.Title', value: item.title },
    { op: 'add', path: '/fields/System.AreaPath', value: ctx.areaPath },
    {
      op: 'add',
      path: '/fields/System.IterationPath',
      value: iterationPathFor(item, ctx),
    },
    {
      op: 'add',
      path: '/fields/Microsoft.VSTS.Common.Priority',
      value: clampPriority(item.priority),
    },
  ];

  // System.Description is alwaysRequired on this process; always send it (fall back to the title).
  ops.push({
    op: 'add',
    path: '/fields/System.Description',
    value: item.description?.trim() || item.title,
  });

  // Value Area is required on portfolio items (Epic/Feature) and PBIs (Stories).
  if (
    item.type === BacklogItemType.Epic ||
    item.type === BacklogItemType.Feature ||
    item.type === BacklogItemType.Story
  ) {
    ops.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Common.ValueArea',
      value: DEFAULT_VALUE_AREA,
    });
  }

  // Epics and Features require Start + Target dates.
  if (item.type === BacklogItemType.Epic || item.type === BacklogItemType.Feature) {
    const { start, target } = scheduleWindow();
    ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StartDate', value: start });
    ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.TargetDate', value: target });
  }

  // Stories (PBIs) require an Effort estimate.
  if (item.type === BacklogItemType.Story) {
    ops.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.Effort',
      value: DEFAULT_EFFORT,
    });

    // The Story is assigned here, but **not** moved into its ready state here.
    //
    // Azure DevOps validates `System.State` differently on a create than on an ordinary
    // transition: it answered that a Product Backlog Item supports `New, Approved, Committed,
    // Done, Removed` and then rejected a create carrying `Approved` as "not in the list of
    // supported values". Transitioning the same item afterwards is the path the task board uses
    // every day and works fine, so the push creates the item and then moves it — see
    // `markStoryReady` in the push service.
    if (ctx.developerAssignee) {
      ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: ctx.developerAssignee });
    }
  }

  // Tasks require an Activity drawn from the process's fixed list.
  if (item.type === BacklogItemType.Task) {
    ops.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Common.Activity',
      value: DEFAULT_ACTIVITY,
    });
  }

  // Acceptance Criteria is required on Stories (PBIs) and Tasks in this process.
  if (item.type === BacklogItemType.Story || item.type === BacklogItemType.Task) {
    ops.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
      value: item.acceptanceCriteria?.trim() || REQUIRED_TEXT_FALLBACK,
    });
  }

  // Assignment applies to Tasks — the unit of developer work.
  if (item.type === BacklogItemType.Task && ctx.developerAssignee) {
    ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: ctx.developerAssignee });
  }

  /*
   * The repo tag travels with Stories as well as Tasks.
   *
   * It used to be written on Tasks only, on the grounds that a Task is what a Developer works on.
   * But QA works on **Stories**, and resolves the repository to clone from exactly this tag. With
   * no tag the resolver falls back to "the project's only repo" — which works right up until a
   * project has two. On a two-repo project every Story was rejected as "no target repository
   * resolvable", the QA wave dispatched nothing, and the cause was invisible from the board.
   *
   * That fix was not enough on its own. A Story whose Tasks span **both** repositories has no
   * repository of its own, so there was still nothing to write — and those Stories hit the very
   * same rejection. `repo` now carries one inherited from the Story's children; see
   * `repo-inheritance.ts`.
   */
  const tagRepo = repo ?? item.repo;
  if (tagRepo) {
    ops.push({ op: 'add', path: '/fields/System.Tags', value: `repo:${tagRepo}` });
  }

  if (parentUrl) {
    ops.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: parentUrl,
        attributes: { comment: 'Created from approved planning draft.' },
      },
    });
  }

  return ops;
}

/**
 * Orders items so every item appears after its parent (parents must be created first to link
 * children). Stable within a depth so sibling `order` is preserved. Items whose parent is missing
 * are treated as roots.
 */
export function orderParentsFirst(items: BacklogItem[]): BacklogItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depthCache = new Map<string, number>();

  const depth = (item: BacklogItem, seen: Set<string>): number => {
    if (depthCache.has(item.id)) return depthCache.get(item.id)!;
    if (!item.parentId || !byId.has(item.parentId) || seen.has(item.id)) {
      depthCache.set(item.id, 0);
      return 0;
    }
    seen.add(item.id);
    const d = depth(byId.get(item.parentId)!, seen) + 1;
    depthCache.set(item.id, d);
    return d;
  };

  return items
    .map((item, index) => ({ item, index, depth: depth(item, new Set()) }))
    .sort((a, b) => a.depth - b.depth || a.item.order - b.item.order || a.index - b.index)
    .map((x) => x.item);
}

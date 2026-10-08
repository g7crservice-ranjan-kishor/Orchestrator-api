import { BacklogItem, BacklogItemType } from './schemas/draft.schema';
import { dependencyTargets } from './dependency-refs';
import { planRisks } from './plan-validation';
import { repoNameOf } from '../development/repo-resolution';
import { configurationNeeds } from './configuration-needs';
import {
  contradictedBy,
  criteriaIgnoreTitle,
  describeOperation,
  namesHttpMethod,
} from './story-operation';

/** A single backlog validation issue tied to an item (or the backlog as a whole). */
export interface ValidationIssue {
  itemId: string | null;
  severity: 'error' | 'warning';
  message: string;
}

/** What each non-leaf type must contain to be worth anything. Only a **Task** is ever
 * dispatched to an agent, so an item with no descendants down to Task is work that will
 * silently never be built. */
const REQUIRED_CHILD: Partial<Record<BacklogItemType, BacklogItemType>> = {
  [BacklogItemType.Epic]: BacklogItemType.Feature,
  [BacklogItemType.Feature]: BacklogItemType.Story,
  [BacklogItemType.Story]: BacklogItemType.Task,
};

/**
 * A Task that brings a repository into existence: scaffolding, project initialisation, the
 * routing skeleton. Matched on the title because nothing in the schema marks it — deliberately
 * narrow, so an ordinary Task is not mistaken for one.
 */
const FOUNDATION_TASK =
  /\b(initiali[sz]e|scaffold|bootstrap)\b|\bset up\b[^.]*\b(project|skeleton)\b/i;

/**
 * Dispatch order, mirroring `orderParentsFirst`: within one depth an item is sequenced by its
 * `order`, then by its position in the backlog. Azure DevOps ids are assigned in this order and
 * the development queue runs in id order, so this is the order work actually happens in.
 */
function dispatchOrder(items: BacklogItem[]): Map<string, number> {
  const tasks = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === BacklogItemType.Task)
    .sort((a, b) => a.item.order - b.item.order || a.index - b.index);
  return new Map(tasks.map(({ item }, position) => [item.id, position]));
}

/** Options that need facts from outside the backlog itself. */
export interface ValidationContext {
  /** The project's repositories (clone URLs or names). Enables the per-Task repo check. */
  targetRepos?: string[];
  /**
   * The approved plan, so the risks it names can be checked against the work that was drafted.
   * Absent for callers with no plan to hand; the risk check then does nothing.
   */
  planMarkdown?: string | null;
}

/**
 * Is this a product with a separate interface and server — the shape whose seam needs testing?
 *
 * Repositories are configured from the plan, after planning, so they are not a reliable answer on
 * their own: at the moment a plan is first validated the project may still have none. The plan
 * itself always knows, because it is what the repositories were derived from. Asking the
 * repositories first keeps the answer right for every project configured before this existed.
 */
function isSplitProduct(context: ValidationContext): boolean {
  if ((context.targetRepos?.length ?? 0) >= 2) return true;
  const plan = context.planMarkdown ?? '';
  return plan.length > 0 && configurationNeeds(plan, 'product').repositories.length >= 2;
}

/** Words that only appear when a Story means "drive the real thing in a browser". */
const BROWSER_JOURNEY = /\b(browser|playwright|cypress|puppeteer|selenium|webdriver)\b/i;

/**
 * A project split across repositories must test the seam between them, in a browser.
 *
 * The defects that survived every other gate all lived *between* the two applications: the API had
 * no CORS handling, so the browser blocked every call; the interface pointed at a port the API did
 * not listen on; the task list rendered blank because it read a field the API never sent. Not one
 * was reachable by the tests that existed — unit tests mock the API, API tests have no interface,
 * and the QA agent verified the "end-to-end" Story with `curl`, which never sends an Origin header
 * and never renders a table.
 *
 * So the rule is not "write more tests", it is: **something must drive the real thing in a real
 * browser**, and the backlog must say so. Single-repository projects are exempt — there is no seam.
 */
/**
 * Acceptance criteria have to be about the item they are attached to.
 *
 * A Story titled `PUT /employees/:id (update)` carried the criteria for creating — "creates the
 * employee, persists it, and returns 201 with the created employee" — and the DELETE Story beneath
 * it carried the update criteria. The whole set was shifted by one. Every criterion was
 * well-formed, so nothing else noticed: the repository was right, the sprint was right, the parent
 * link was right.
 *
 * It matters because **QA verifies against the acceptance criteria**. A delete Story checked
 * against update criteria passes while delete is broken — and delete had no criteria of its own at
 * all, so nobody would ever have tested it.
 */
function criteriaMatchIssues(items: BacklogItem[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allTitles = items.map((i) => i.title ?? '');
  for (const item of items) {
    // A Story's criteria that never mention anything its own title is about. This catches the
    // shifting the operation comparison cannot: "Logout endpoint and session invalidation" whose
    // criteria describe creating an employee claims no operation to contradict, but says nothing
    // about logging out either. Stories only — a Task's criteria properly say "implements every
    // criterion on the parent Story", which shares no words with its title by design.
    if (
      item.type === BacklogItemType.Story &&
      criteriaIgnoreTitle(item.title ?? '', item.acceptanceCriteria ?? '', allTitles)
    ) {
      issues.push({
        itemId: item.id,
        severity: 'error',
        message:
          'The acceptance criteria never mention what this Story is about — they describe ' +
          'changing something else entirely. QA verifies against these criteria, so this Story ' +
          'would be signed off without its own behaviour ever being tested. Rewrite them to ' +
          'describe what this Story does.',
      });
      continue;
    }
    // Stories describe behaviour, so their titles mean what they say. A Task's title is a note to
    // whoever picks it up — "Add response-schema validation tests", whose criteria mention a field
    // being "removed", claims nothing about deleting anything. Only an explicit HTTP method makes
    // a Task's claim unambiguous enough to hold it to.
    const checkable = item.type === BacklogItemType.Story || namesHttpMethod(item.title ?? '');
    if (!checkable) continue;
    const wrong = contradictedBy(item.title ?? '', item.acceptanceCriteria ?? '');
    if (!wrong) continue;
    issues.push({
      itemId: item.id,
      severity: 'error',
      message:
        `The acceptance criteria describe ${describeOperation(wrong)}, but the title says this ` +
        'item is about something else. QA verifies against these criteria, so the work they ' +
        'describe would be tested and the work in the title would not. Rewrite them to match ' +
        'what this item actually does.',
    });
  }
  return issues;
}

/** The sprint number in a name like "Sprint 3", or null when it is not numbered that way. */
export function sprintNumber(sprint: string | null | undefined): number | null {
  const digits = /(\d+)/.exec(sprint ?? '');
  return digits ? Number(digits[1]) : null;
}

/**
 * No work may be scheduled before the work it belongs to.
 *
 * A Task in Sprint 2 whose Story is in Sprint 3 cannot be done: its Story has not been built yet,
 * so a developer picking it up has nothing to attach it to. It is not caught by anything else —
 * every item is individually valid, the parent link is correct, and both sprints exist — so it
 * reaches the board and sits there, or worse, gets built against something that is not there.
 *
 * Only numbered sprints are compared; a backlog that names its sprints some other way is left
 * alone rather than guessed at.
 */
function sprintOrderIssues(items: BacklogItem[]): ValidationIssue[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const issues: ValidationIssue[] = [];
  for (const item of items) {
    const mine = sprintNumber(item.sprint);
    if (mine === null) continue;

    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    const owner = parent ? sprintNumber(parent.sprint) : null;
    if (parent && owner !== null && mine < owner) {
      issues.push({
        itemId: item.id,
        severity: 'error',
        message:
          `Scheduled for ${item.sprint}, before its parent "${parent.title}" in ${parent.sprint}. ` +
          'Work cannot start before the item it belongs to — move it to that sprint or later.',
      });
    }

    // The same rule across the tree rather than down it. A Settings toggle a sprint before the
    // Settings drawer it lives in is not a parent/child mistake — the two are in different
    // branches — so only the stated dependency can catch it.
    for (const needed of item.dependsOn ?? []) {
      const dependency = byId.get(needed);
      const needs = dependency ? sprintNumber(dependency.sprint) : null;
      if (!dependency || needs === null || mine >= needs) continue;
      issues.push({
        itemId: item.id,
        severity: 'error',
        message:
          `Scheduled for ${item.sprint}, before "${dependency.title}" in ${dependency.sprint}, ` +
          'which it depends on. Move it to that sprint or later, or drop the dependency.',
      });
    }
  }
  return issues;
}

function browserJourneyIssues(items: BacklogItem[], context: ValidationContext): ValidationIssue[] {
  if (!isSplitProduct(context)) {
    return [];
  }
  const mentionsBrowser = items.some((item) =>
    BROWSER_JOURNEY.test(
      `${item.title ?? ''} ${item.description ?? ''} ${item.acceptanceCriteria ?? ''}`,
    ),
  );
  if (mentionsBrowser) {
    return [];
  }
  return [
    {
      itemId: null,
      severity: 'error',
      message:
        'This application spans more than one repository, and nothing in the backlog tests the ' +
        'two together in a browser. Add a Story (with Tasks) that starts both applications and ' +
        'drives one real user journey end to end in a browser — naming the tool, for example ' +
        'Playwright. A request the browser blocks (CORS), a mismatched API URL or port, and a ' +
        'field the interface reads that the API never sends are invisible to unit tests, to API ' +
        'tests, and to curl.',
    },
  ];
}

/** The contract, and something that makes it enforceable rather than descriptive. */
const CONTRACT = /contract|openapi|swagger/i;
const ENFORCED = /type|schema|conformance|conform|generate|generated|validate|validation|verif/i;

/**
 * A shared contract must be *enforced* somewhere, not merely written.
 *
 * The last project produced a correct OpenAPI contract. The API followed it and returned
 * `{ tasks: [...] }`. The interface hand-wrote its own types, expected a bare array, and rendered
 * an empty page for every user. Both repositories compiled. Both test suites passed — the
 * interface's tests mock the API, so the mock returned whatever the interface already believed.
 *
 * A document that nothing checks is a document two codebases can quietly disagree with. The
 * backlog must contain work that turns the contract into a failure somebody sees: types generated
 * from it, or responses validated against it in a suite that runs. Either one makes the mismatch a
 * red build instead of a blank screen.
 */
function contractConformanceIssues(
  items: BacklogItem[],
  context: ValidationContext,
): ValidationIssue[] {
  if (!isSplitProduct(context)) return [];

  const enforced = items.some((item) => {
    const text = `${item.title ?? ''} ${item.description ?? ''} ${item.acceptanceCriteria ?? ''}`;
    return CONTRACT.test(text) && ENFORCED.test(text);
  });
  if (enforced) return [];

  return [
    {
      itemId: null,
      severity: 'error',
      message:
        'This application spans more than one repository, and nothing in the backlog makes the ' +
        'API contract enforceable. Add work that either generates the frontend API types from the ' +
        'contract, or validates the API responses against the contract in a suite that runs. ' +
        'A contract nothing checks is a document both sides can disagree with: on the last ' +
        'project the API returned `{ tasks: [...] }`, the interface read a bare array, both ' +
        'compiled, both test suites passed, and every user saw an empty page.',
    },
  ];
}

/**
 * Work the plan promised against a risk, which the backlog never contains.
 *
 * The plan for the last project named the CORS risk precisely and was approved on that basis. No
 * Story was ever drafted for it, nobody noticed, and the API shipped unable to serve a browser at
 * all. A risk is addressed when it is *work*, not when it is written down — and the plan now says
 * which work, so this can check that the work exists.
 */
function unbuiltMitigationIssues(
  items: BacklogItem[],
  context: ValidationContext,
): ValidationIssue[] {
  const plan = context.planMarkdown?.trim();
  if (!plan) return [];

  const drafted = items
    .map((i) => normaliseTitle(i.title ?? ''))
    .filter(Boolean)
    .join(' | ');

  const missing = planRisks(plan)
    .map((r) => r.mitigation)
    .filter((m): m is string => Boolean(m))
    .filter((m) => {
      const key = normaliseTitle(m);
      if (key.length <= 3) return false;
      if (drafted.includes(key)) return false;
      // A mitigation is often drafted under different words, or split across more than one item:
      // "Backend validation on create and update endpoints" became a Task per endpoint. The
      // question this gate asks is whether the work exists at all, so most of the mitigation's
      // own words turning up across the backlog's titles is enough to answer it. A mitigation
      // nobody drafted — the CORS risk that went unaddressed — still shares almost nothing.
      return !mostWordsAppear(key, drafted);
    });

  if (missing.length === 0) return [];
  return [
    {
      itemId: null,
      severity: 'error',
      message:
        `The plan says ${missing.length} risk(s) are mitigated by work that is not in this ` +
        `backlog: ${missing.join('; ')}. Draft it, or the risk is unaddressed — the last project ` +
        'named its CORS risk, drafted nothing for it, and shipped an API no browser could call.',
    },
  ];
}

/** Allowed parent type for each item type (the Epic→Feature→Story→Task hierarchy). */
const ALLOWED_PARENT: Record<BacklogItemType, BacklogItemType | null> = {
  [BacklogItemType.Epic]: null,
  [BacklogItemType.Feature]: BacklogItemType.Epic,
  [BacklogItemType.Story]: BacklogItemType.Feature,
  [BacklogItemType.Task]: BacklogItemType.Story,
};

/** Detects a cycle in the `dependsOn` graph starting from `startId` (DFS with a recursion stack). */
function hasDependencyCycle(byId: Map<string, BacklogItem>): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 'visiting') return true;
    if (s === 'done') return false;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  for (const id of byId.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

/** Normalises a title for duplicate detection (trimmed, case-insensitive, whitespace-collapsed). */
/** Do most of a phrase's own words turn up in the text? */
function mostWordsAppear(phrase: string, text: string): boolean {
  const words = [...new Set(phrase.split(' ').filter((w) => w.length > 3))];
  if (words.length === 0) return false;
  const present = words.filter((w) => text.includes(w)).length;
  return present / words.length >= 0.6;
}

function normaliseTitle(title: string): string {
  return (
    title
      .trim()
      // Punctuation is not meaning. The plan wrote "Database bootstrap — seed administrator
      // account" and the backlog drafted "Database bootstrap: seed administrator account"; an
      // em dash against a colon was enough to report a drafted mitigation as missing, and that
      // false positive alone stopped the correction loop after a single round.
      .replace(/[^a-z0-9/]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/**
 * Validates a draft backlog: non-empty titles, no duplicate items, valid parent references, correct
 * type nesting (Epic→Feature→Story→Task), present acceptance criteria on Stories, existing
 * dependency targets, and no dependency cycles. Pure and testable; the backend and UI both surface
 * the returned issues (TESTING_STRATEGY.md §3.5).
 *
 * It also checks **coverage** — that every Epic reaches a Feature, every Feature a Story and every
 * Story a Task — and, when the project's repositories are supplied, that every Task names one of
 * them. Both are errors rather than warnings: each describes work that cannot be executed, and a
 * backlog that cannot be executed should not reach Azure DevOps looking like a success.
 */
export function validateBacklog(
  items: BacklogItem[],
  context: ValidationContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));

  // Duplicate detection: two or more items sharing a normalised title are flagged as duplicates.
  const titleCounts = new Map<string, number>();
  for (const item of items) {
    const key = normaliseTitle(item.title ?? '');
    if (key) {
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
  }

  for (const item of items) {
    if (!item.title?.trim()) {
      issues.push({ itemId: item.id, severity: 'error', message: 'Title is required.' });
    } else if ((titleCounts.get(normaliseTitle(item.title)) ?? 0) > 1) {
      issues.push({
        itemId: item.id,
        severity: 'warning',
        message: `Duplicate item: another item shares the title "${item.title.trim()}".`,
      });
    }

    // Acceptance criteria are what QA tests against and what a Developer builds to. A Story
    // without them reaches Azure DevOps as an item nobody can verify — and a backlog of 30
    // Stories arrived with **none**, because this was a warning and warnings do not block.
    if (item.type === BacklogItemType.Story && !item.acceptanceCriteria?.trim()) {
      issues.push({
        itemId: item.id,
        severity: 'error',
        message: 'Acceptance criteria are missing — there is nothing for QA to verify.',
      });
    }
    if (item.parentId) {
      const parent = byId.get(item.parentId);
      if (!parent) {
        issues.push({
          itemId: item.id,
          severity: 'error',
          message: `Parent ${item.parentId} does not exist.`,
        });
      } else if (ALLOWED_PARENT[item.type] !== parent.type) {
        issues.push({
          itemId: item.id,
          severity: 'error',
          message: `A ${item.type} cannot be a child of a ${parent.type}.`,
        });
      }
    } else if (ALLOWED_PARENT[item.type] !== null) {
      issues.push({
        itemId: item.id,
        severity: 'warning',
        message: `A ${item.type} normally has a ${ALLOWED_PARENT[item.type]} parent.`,
      });
    }
    /*
     * A dependency may also name an Azure DevOps work item outright (`#790`).
     *
     * An enhancement depends on work from the *original* plan — "add a dark mode toggle to the
     * Settings page" needs **Build the Settings page**, which is not in this backlog and was pushed
     * weeks ago. Rejecting those as "does not exist" would make a cross-plan dependency impossible
     * to state, which is the one thing that stops a new Task running against a page nobody has
     * built yet.
     */
    for (const dep of dependencyTargets(item, byId).unknown) {
      issues.push({
        itemId: item.id,
        severity: 'error',
        message: `Dependency ${dep} does not exist.`,
      });
    }
  }

  // Coverage. The failure this prevents: a backlog where 21 of 29 Stories had no Task passed
  // every structural rule, was approved, and reached Azure DevOps — the design system, the
  // application shell, the login screen and the whole task CRUD arrived as items no agent
  // would ever pick up, and nothing anywhere said so.
  const childTypes = new Map<string, Set<BacklogItemType>>();
  for (const item of items) {
    if (!item.parentId) continue;
    const set = childTypes.get(item.parentId) ?? new Set<BacklogItemType>();
    set.add(item.type);
    childTypes.set(item.parentId, set);
  }
  for (const item of items) {
    const required = REQUIRED_CHILD[item.type];
    if (required && !childTypes.get(item.id)?.has(required)) {
      issues.push({
        itemId: item.id,
        severity: 'error',
        message:
          `This ${item.type} has no ${required}. Only a Task is dispatched to an agent, so ` +
          'nothing under it would ever be built.',
      });
    }
  }

  // Repository. A Task naming a repository the project does not have cannot be executed by
  // anyone: it resolves to no repository and sits in To Do with no agent assigned.
  const valid = (context.targetRepos ?? []).map(repoNameOf).filter(Boolean);
  if (valid.length > 0) {
    for (const item of items) {
      if (item.type !== BacklogItemType.Task) continue;
      const repo = item.repo?.trim();
      if (!repo) {
        issues.push({
          itemId: item.id,
          severity: 'error',
          message: `Task has no repository. Expected one of: ${valid.join(', ')}.`,
        });
      } else if (!valid.includes(repo)) {
        issues.push({
          itemId: item.id,
          severity: 'error',
          message:
            `Repository "${repo}" is not one of this project's repositories ` +
            `(${valid.join(', ')}).`,
        });
      }
    }
  }

  // Ordering. The failure this prevents: a backlog whose scaffolding Tasks sat 49th of 59, so
  // `Define User Prisma model` ran before Prisma was installed and quietly scaffolded the whole
  // project inside itself — leaving the real initialisation Task to duplicate work that already
  // existed. The rule was written into the Scrum Master template and never checked.
  const position = dispatchOrder(items);
  const byRepo = new Map<string, BacklogItem[]>();
  for (const item of items) {
    if (item.type !== BacklogItemType.Task) continue;
    const repo = item.repo?.trim();
    if (!repo) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), item]);
  }
  for (const [repo, tasks] of byRepo) {
    const foundation = tasks
      .filter((t) => FOUNDATION_TASK.test(t.title ?? ''))
      .sort((a, b) => position.get(a.id)! - position.get(b.id)!)[0];
    if (!foundation) continue;
    const at = position.get(foundation.id)!;
    const before = tasks.filter((t) => position.get(t.id)! < at);
    if (before.length > 0) {
      issues.push({
        itemId: foundation.id,
        severity: 'error',
        message:
          `${before.length} ${repo} Task(s) are sequenced before "${foundation.title}" sets the ` +
          `repository up. Whichever runs first has to invent the project layout instead.`,
      });
    }
  }

  if (hasDependencyCycle(byId)) {
    issues.push({ itemId: null, severity: 'error', message: 'Dependency cycle detected.' });
  }

  issues.push(...criteriaMatchIssues(items));
  issues.push(...sprintOrderIssues(items));
  issues.push(...browserJourneyIssues(items, context));
  issues.push(...unbuiltMitigationIssues(items, context));
  issues.push(...contractConformanceIssues(items, context));
  return issues;
}

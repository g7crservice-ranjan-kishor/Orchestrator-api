import { CLAUDE_DEVELOPER } from './task-transition-rules';

/**
 * Every `repo:<name>` value in ADO's semicolon-delimited tag string.
 *
 * Plural on purpose. A work item can accumulate more than one — Azure DevOps *appends* when a
 * patch writes `System.Tags`, so correcting a repository name leaves the old tag in place beside
 * the new one. Taking only the first then disables the Task whenever the stale tag happens to sort
 * first, which is exactly how two Tasks ended up with no execution agent while their neighbours
 * were fine.
 */
export function parseRepoTags(tags: string): string[] {
  return tags
    .split(';')
    .map((tag) => /^\s*repo:(.+?)\s*$/i.exec(tag)?.[1].trim())
    .filter((name): name is string => Boolean(name));
}

/**
 * The repo tags that actually apply to a work item: its own, or its parent's.
 *
 * A Bug filed by a QA agent, or a Task whose tag was never written, has no repository of its
 * own — and on a project with more than one target repo, nothing can be resolved from nothing,
 * so the board refuses to start it with "No execution agent is assigned to this Task". The
 * parent Story always knows. Inheriting one level covers the real hierarchy (Bugs and Tasks both
 * hang off a Story) without a second round trip to walk further up.
 */
export function effectiveRepoTags(
  ownTags: string | null | undefined,
  parentTags?: string | null,
): string[] {
  const own = parseRepoTags(ownTags ?? '');
  return own.length > 0 ? own : parseRepoTags(parentTags ?? '');
}

/** The first `repo:` tag, for callers that only need one. */
export function parseRepoTag(tags: string): string | null {
  return parseRepoTags(tags)[0] ?? null;
}

/**
 * The repository name inside a target, which may be a bare name or a clone URL:
 * `https://dev.azure.com/org/Project/_git/taskmanager-api` → `taskmanager-api`.
 */
export function repoNameOf(target: string): string {
  return (
    target
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean)
      .pop()
      ?.toLowerCase() ?? ''
  );
}

/**
 * Resolves the repository a Task's development run targets: its own `repo:` tag when that repo is
 * allowed for the project, else the project's sole target repo. Returns undefined when the target is
 * ambiguous (several repos, no tag) — the Task then has no execution target.
 *
 * A project lists its targets as **clone URLs**, because that string is what the pod git-clones,
 * while a Task is tagged with the **repository name**, which is what a person writes on a work
 * item. Matching by name bridges the two: without it, a project with more than one repository can
 * never resolve a Task, since no tag equals a URL and the "sole repo" fallback does not apply.
 */
export function resolveRepo(
  targetRepos: string[],
  repoTag: string | string[] | null | undefined,
): string | undefined {
  // Several tags are possible (see parseRepoTags). The one that names a repository this project
  // actually targets wins, wherever it sits in the list — a stale tag left behind by a rename must
  // not decide, and must not veto.
  const candidates = (Array.isArray(repoTag) ? repoTag : [repoTag]).filter((tag): tag is string =>
    Boolean(tag),
  );

  for (const tag of candidates) {
    if (targetRepos.length === 0 || targetRepos.includes(tag)) {
      return tag;
    }
    // Return the project's own target, not the tag: the caller clones the value it gets back.
    const named = targetRepos.find((target) => repoNameOf(target) === repoNameOf(tag));
    if (named) {
      return named;
    }
  }
  return targetRepos.length === 1 ? targetRepos[0] : undefined;
}

/**
 * The repository a **QA** run starts from.
 *
 * Identical to {@link resolveRepo} except that it never gives up while the project has a target: an
 * untagged Story falls back to the project's first repository rather than becoming untestable.
 *
 * That fallback is safe here and **only** here. A QA pod clones every other repository of the
 * project as a companion (`buildRunContext`'s `companionRepos`), so where it starts decides only
 * its working directory, not what it can see. A Developer run is the opposite: it commits, into one
 * repository, and starting in the wrong one would put the work in the wrong place — which is why
 * {@link resolveRepo} still returns undefined there and the Task is refused instead.
 *
 * Without this, three Stories on a two-repository product — the ones whose Tasks span both,
 * including the browser end-to-end journey — could never be tested at all.
 */
export function resolveQaRepo(
  targetRepos: string[],
  repoTag: string | string[] | null | undefined,
): string | undefined {
  return resolveRepo(targetRepos, repoTag) ?? targetRepos[0];
}

/**
 * The execution agent that can run a Task. The orchestrator's only developer agent is the **Claude
 * Developer**, and it can only run a Task whose target repository resolves — so an unresolvable repo
 * means "no execution agent assigned", which blocks `To Do → In Progress`. Kept separate from ADO's
 * `Assigned To` (a person), which planning may legitimately leave empty.
 */
export function resolveExecutionAgent(
  targetRepos: string[],
  repoTag: string | string[] | null | undefined,
): string | null {
  return resolveRepo(targetRepos, repoTag) ? CLAUDE_DEVELOPER : null;
}

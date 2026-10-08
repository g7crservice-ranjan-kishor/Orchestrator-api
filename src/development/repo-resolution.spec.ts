import {
  parseRepoTag,
  parseRepoTags,
  resolveExecutionAgent,
  resolveQaRepo,
  resolveRepo,
} from './repo-resolution';
import { CLAUDE_DEVELOPER } from './task-transition-rules';

/**
 * Which repository a Task's development run clones.
 *
 * The two sides speak different dialects: a project lists **clone URLs**, because that is the
 * string the pod hands to `git clone`, while a Task carries a `repo:` tag written by a person,
 * which is a bare repository name. Reconciling them is the whole job here — and getting it wrong
 * silently disables every Task in a multi-repository project, which is how it was found.
 */
describe('resolveRepo', () => {
  const API = 'https://dev.azure.com/org/Task-Manager/_git/taskmanager-api';
  const UI = 'https://dev.azure.com/org/Task-Manager/_git/taskmanager-ui';

  it('matches a name tag to the clone URL that carries that name', () => {
    expect(resolveRepo([UI, API], 'taskmanager-api')).toBe(API);
    expect(resolveRepo([UI, API], 'taskmanager-ui')).toBe(UI);
  });

  /** The caller clones whatever comes back, so a URL must come back, never the bare tag. */
  it('returns the project’s target, not the tag', () => {
    expect(resolveRepo([UI, API], 'taskmanager-api')).toMatch(/^https:\/\//);
  });

  it('ignores case and a trailing .git', () => {
    expect(resolveRepo([`${API}.git`], 'TaskManager-API')).toBe(`${API}.git`);
  });

  it('still takes an exact match when the project lists bare names', () => {
    expect(resolveRepo(['taskmanager-api', 'taskmanager-ui'], 'taskmanager-api')).toBe(
      'taskmanager-api',
    );
  });

  it('falls back to the only repository when the Task is untagged', () => {
    expect(resolveRepo([API], null)).toBe(API);
  });

  it('refuses to guess between several repositories when the Task is untagged', () => {
    expect(resolveRepo([UI, API], null)).toBeUndefined();
  });

  it('refuses a tag naming a repository the project does not target', () => {
    expect(resolveRepo([UI, API], 'some-other-repo')).toBeUndefined();
  });

  it('trusts the tag when the project constrains nothing', () => {
    expect(resolveRepo([], 'taskmanager-api')).toBe('taskmanager-api');
  });
});

describe('resolveExecutionAgent', () => {
  const API = 'https://dev.azure.com/org/Task-Manager/_git/taskmanager-api';
  const UI = 'https://dev.azure.com/org/Task-Manager/_git/taskmanager-ui';

  /** "No execution agent assigned" on a card means exactly this: the repository did not resolve. */
  it('assigns the Claude Developer once the repository resolves', () => {
    expect(resolveExecutionAgent([UI, API], 'taskmanager-api')).toBe(CLAUDE_DEVELOPER);
  });

  it('assigns nobody when the repository is ambiguous', () => {
    expect(resolveExecutionAgent([UI, API], null)).toBeNull();
  });
});

/**
 * Azure DevOps *appends* when a patch writes `System.Tags`, so correcting a repository name leaves
 * the old tag beside the new one. Forty-seven of forty-eight Tasks ended up carrying two, and the
 * two whose stale tag happened to sort first lost their execution agent entirely.
 */
describe('a work item carrying more than one repo tag', () => {
  const API = 'https://dev.azure.com/org/Task-Manager/_git/taskmanager-api';
  const UI = 'https://dev.azure.com/org/Task-Manager/_git/taskmanager-ui';

  it('reads every repo tag, in order', () => {
    expect(parseRepoTags('repo:task-manager-api; repo:taskmanager-ui; task-manager-ui')).toEqual([
      'task-manager-api',
      'taskmanager-ui',
    ]);
  });

  it('resolves the tag that names a real target, wherever it sits', () => {
    const tags = parseRepoTags('repo:task-manager-api; repo:taskmanager-ui');
    expect(resolveRepo([UI, API], tags)).toBe(UI);
    expect(resolveExecutionAgent([UI, API], tags)).not.toBeNull();
  });

  /** A leftover tag must not veto the Task, which is precisely what went wrong. */
  it('is not blocked by a stale tag that sorts first', () => {
    expect(resolveRepo([UI, API], ['task-manager-api', 'taskmanager-api'])).toBe(API);
  });

  it('still resolves nothing when no tag names a target', () => {
    expect(resolveRepo([UI, API], ['task-manager-api', 'some-other-repo'])).toBeUndefined();
  });

  it('ignores tags that are not repo tags', () => {
    expect(parseRepoTags('phase:0; qa-verified; task-manager-ui')).toEqual([]);
  });
});

describe('parseRepoTag', () => {
  it('reads the repo tag out of ADO’s semicolon-delimited tag string', () => {
    expect(parseRepoTag('phase:0; repo:taskmanager-api; qa-verified')).toBe('taskmanager-api');
  });

  it('is null when no repo tag is present', () => {
    expect(parseRepoTag('phase:0; qa-verified')).toBeNull();
  });
});

/**
 * QA starts somewhere; a Developer starts in the right place.
 *
 * A Story whose Tasks span both repositories carries no repository of its own. QA clones every
 * other repository of the project as a companion, so where it starts is a working directory rather
 * than a claim — and refusing to start at all meant three Stories on the Employee Management System
 * could never be tested, including the browser end-to-end journey. A Developer run commits, into
 * one repository, so the same fallback there would put work in the wrong place.
 */
describe('resolveQaRepo', () => {
  const API = 'https://dev.azure.com/org/P/_git/ems-api';
  const UI = 'https://dev.azure.com/org/P/_git/ems-ui';

  it('resolves a tagged Story exactly as a Task would', () => {
    expect(resolveQaRepo([API, UI], 'ems-ui')).toBe(UI);
  });

  it('starts an untagged Story in the first repository rather than refusing it', () => {
    expect(resolveQaRepo([API, UI], null)).toBe(API);
  });

  /** Where a Developer run must still refuse. */
  it('is the only one that falls back — resolveRepo still gives up', () => {
    expect(resolveRepo([API, UI], null)).toBeUndefined();
  });

  it('has nothing to offer when the project has no repository at all', () => {
    expect(resolveQaRepo([], null)).toBeUndefined();
  });
});

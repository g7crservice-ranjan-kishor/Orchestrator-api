import { PlanningService } from './planning.service';
import { JobRole } from '../jobs/job-state';

/**
 * Which repositories a run is handed beside the one it targets.
 *
 * Each role gets a different answer for a different reason, and getting any of them wrong has
 * already cost something:
 *
 * - **Planning** targeted none, so it was given none — the EM agent planned from the written
 *   requirement having never read a line of the product. Survivable for a first build, where there
 *   is nothing to read. Impossible for an enhancement: a plan for "dark mode on every screen"
 *   written by an agent that cannot see the screens is a guess, and "do not break what works"
 *   cannot be honoured by one that cannot see what works.
 * - **QA** was given only the repository its Story was tagged with, so "verify the application end
 *   to end" became "call the API with curl" — and passed a Story whose interface could not reach
 *   its API at all.
 * - **Developer** must get nothing extra: one Task, one repository, one commit. Handing it a second
 *   checkout is an invitation to commit into the wrong one.
 */
const API = 'https://dev.azure.com/org/P/_git/ems-api';
const UI = 'https://dev.azure.com/org/P/_git/ems-ui';
const REPOS = [API, UI];

describe('PlanningService.reposFor', () => {
  it('gives a planning run every repository, because it targets none', () => {
    expect(PlanningService.reposFor({ role: JobRole.EM }, REPOS)).toEqual([API, UI]);
    expect(PlanningService.reposFor({ role: JobRole.SM }, REPOS)).toEqual([API, UI]);
  });

  it('gives QA the repositories its own work item is not in', () => {
    expect(PlanningService.reposFor({ role: JobRole.QA, repo: API }, REPOS)).toEqual([UI]);
  });

  it('gives a Developer run nothing beside its own repository', () => {
    expect(PlanningService.reposFor({ role: JobRole.Developer, repo: API }, REPOS)).toEqual([]);
  });

  /** A first build has nothing to read; the prompt must then say nothing about checkouts. */
  it('gives a planning run nothing when the project has no repository yet', () => {
    expect(PlanningService.reposFor({ role: JobRole.EM }, [])).toEqual([]);
  });

  /** The returned list is the caller's to keep — a later edit must not reach the project document. */
  it('does not hand back the project’s own array', () => {
    const repos = [API, UI];
    const given = PlanningService.reposFor({ role: JobRole.EM }, repos);
    given.pop();
    expect(repos).toHaveLength(2);
  });
});

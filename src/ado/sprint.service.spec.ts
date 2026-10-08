import { SprintService, normalizeIterationPath } from './sprint.service';
import { AdoClientService, AdoIteration } from './ado-client.service';
import { adoStub } from '../testing/ado-stub';

/**
 * The sprint cache is keyed by **organization and project**, because two orchestrator projects can
 * name the same Azure DevOps project in different organizations and serving one of them the other's
 * sprints would be silently wrong.
 *
 * That keying has a sharp edge, and the product fell on it: the board reads with an owner
 * (`getContext(adoProject, project.id)`) while sprint rollover cleared without one
 * (`invalidate(adoProject)`). The two keys never matched, so finishing Sprint 1 dropped a
 * `platform::` entry nobody had written, left the board's own entry untouched, and the board badge
 * went on reporting "Active: Sprint 1" for the full five-minute TTL after Azure DevOps had already
 * moved to Sprint 2.
 *
 * The rollover spec asserts the call is now made with the owner, but a mock can only pin the call —
 * it cannot show that the wrong key fails to clear anything. These tests run the real cache.
 */
describe('SprintService cache keys', () => {
  const PROJECT = 'Employee Management System';
  const OWNER = '6abe2b5bd8ca853c7a61bd31';
  const OTHER_OWNER = '6ab8197ee44205fe81245cbc';

  /** Azure DevOps separates iteration path segments with a backslash. */
  const SEP = String.fromCharCode(92);

  const sprint = (name: string, timeFrame: AdoIteration['timeFrame']): AdoIteration => ({
    name,
    path: PROJECT + SEP + name,
    timeFrame,
    startDate: null,
    finishDate: null,
  });

  let listTeamIterations: jest.Mock;
  let service: SprintService;
  let savedTeam: string | undefined;

  beforeEach(() => {
    savedTeam = process.env.ADO_TEAM;
    process.env.ADO_TEAM = 'Default Team'; // skips the team lookup; not what these tests are about
    listTeamIterations = jest
      .fn()
      .mockResolvedValue([sprint('Sprint 1', 'current'), sprint('Sprint 2', 'future')]);
    service = new SprintService(
      adoStub({ listTeamIterations, listTeams: jest.fn() }) as AdoClientService,
    );
  });

  afterEach(() => {
    if (savedTeam === undefined) delete process.env.ADO_TEAM;
    else process.env.ADO_TEAM = savedTeam;
  });

  it('serves a repeated read from the cache', async () => {
    await service.getContext(PROJECT, OWNER);
    const again = await service.getContext(PROJECT, OWNER);
    expect(again.currentSprint).toBe('Sprint 1');
    expect(listTeamIterations).toHaveBeenCalledTimes(1);
  });

  /** The behaviour the rollover depends on. */
  it('re-reads Azure DevOps after the owner cleared its own entry', async () => {
    const before = await service.getContext(PROJECT, OWNER);
    expect(before.currentSprint).toBe('Sprint 1');

    listTeamIterations.mockResolvedValue([
      sprint('Sprint 1', 'past'),
      sprint('Sprint 2', 'current'),
    ]);
    service.invalidate(PROJECT, OWNER);

    const after = await service.getContext(PROJECT, OWNER);
    expect(after.currentSprint).toBe('Sprint 2');
  });

  /**
   * The actual defect, stated as a test: clearing without the owner leaves the board's entry in
   * place, and the board keeps reporting the sprint that was just closed.
   */
  it('does not clear an owner entry when the owner is omitted', async () => {
    await service.getContext(PROJECT, OWNER);
    listTeamIterations.mockResolvedValue([
      sprint('Sprint 1', 'past'),
      sprint('Sprint 2', 'current'),
    ]);

    service.invalidate(PROJECT); // what sprint rollover used to do

    const stale = await service.getContext(PROJECT, OWNER);
    expect(stale.currentSprint).toBe('Sprint 1');
    expect(listTeamIterations).toHaveBeenCalledTimes(1);
  });

  /** And the reason the key carries an owner at all. */
  it('keeps two organizations naming the same project apart', async () => {
    await service.getContext(PROJECT, OWNER);
    listTeamIterations.mockResolvedValue([
      sprint('Sprint 1', 'past'),
      sprint('Sprint 2', 'current'),
    ]);

    const other = await service.getContext(PROJECT, OTHER_OWNER);
    expect(other.currentSprint).toBe('Sprint 2');
    expect((await service.getContext(PROJECT, OWNER)).currentSprint).toBe('Sprint 1');
  });

  it('classifies an iteration path whatever its separators and case', () => {
    expect(normalizeIterationPath('Employee Management System' + SEP + 'Sprint 2')).toBe(
      'employee management system/sprint 2',
    );
  });
});

import { BadRequestException } from '@nestjs/common';
import { oneDraftStub } from '../testing/draft-model-stub';
import { AdoProvisioningService } from './ado-provisioning.service';
import { AdoClientService } from './ado-client.service';
import { ProjectsService } from '../projects/projects.service';
import { adoStub } from '../testing/ado-stub';

/**
 * Setting a project up so it is actually ready to run.
 *
 * Both halves of this used to be typed in by hand and believed. A wrong area path is the worst of
 * the two: every query still succeeds and simply returns nothing, so the project looks configured
 * and never finds any work. A wrong clone URL is merely expensive — it fails inside a pod, long
 * after anyone is watching. Neither needs to be guessed, because Azure DevOps can be asked.
 */
describe('AdoProvisioningService', () => {
  /** A real ObjectId: the configuration lookup queries Mongo by project id. */
  const P = '507f1f77bcf86cd799439011';

  const client = (over: Record<string, unknown> = {}) =>
    adoStub({
      listProjects: jest.fn().mockResolvedValue([{ id: '1', name: 'Proj' }]),
      listAreaPaths: jest.fn().mockResolvedValue(['Proj', 'Proj\\Team A']),
      listRepositories: jest.fn().mockResolvedValue([{ id: 'r', name: 'api', remoteUrl: 'u/api' }]),
      ensureAreaPath: jest.fn().mockResolvedValue('Proj\\Team A'),
      listProcesses: jest.fn().mockResolvedValue([
        { id: 'agile-id', name: 'Agile' },
        { id: 'scrum-id', name: 'Scrum' },
      ]),
      createProject: jest.fn().mockResolvedValue(undefined),
      ensureRepository: jest
        .fn()
        .mockImplementation((_p: string, name: string) =>
          Promise.resolve({ id: name, name, remoteUrl: `https://x/_git/${name}` }),
        ),
      withCredentials: undefined as unknown,
      ...over,
    });

  /** `withCredentials` returns a client of its own; the stub answers with itself. */
  const bindable = (stub: AdoClientService) => {
    (stub as unknown as { withCredentials: () => AdoClientService }).withCredentials = () => stub;
    return stub;
  };

  /** The plan the configuration step reads, or none. */
  const drafts = (planMarkdown: string | null = null) =>
    oneDraftStub(planMarkdown === null ? null : { planMarkdown });

  const projects = (over: Record<string, unknown> = {}) =>
    ({
      findById: jest.fn().mockResolvedValue({
        id: P,
        name: 'Expense Tracker',
        adoTarget: { orgUrl: 'https://x', project: 'Proj', areaPath: 'Proj\\Team A' },
        targetRepos: [],
        database: 'sqlserver',
      }),
      update: jest.fn().mockImplementation((_id, patch) => Promise.resolve(patch)),
      create: jest.fn().mockResolvedValue({ id: P }),
      remove: jest.fn().mockResolvedValue(undefined),
      ...over,
    }) as unknown as ProjectsService;

  describe('preflight', () => {
    /** A bad token is an answer, not a server error — the form has to be able to show it. */
    it('reports a token that cannot read the organization instead of throwing', async () => {
      const ado = bindable(client({ listProjects: jest.fn().mockRejectedValue(new Error('401')) }));
      const result = await new AdoProvisioningService(ado, projects(), drafts()).preflight(
        'https://x',
        'bad',
      );
      expect(result.ok).toBe(false);
      expect(result.problem).toMatch(/token/i);
    });

    /** The message has to say which scopes, or the person cannot fix it. */
    it('names the access the token needs', async () => {
      const ado = bindable(client({ listProjects: jest.fn().mockRejectedValue(new Error('401')) }));
      const result = await new AdoProvisioningService(ado, projects(), drafts()).preflight(
        'https://x',
        'x',
      );
      expect(result.problem).toMatch(/Work Items/);
      expect(result.problem).toMatch(/Code/);
    });

    it('lists the projects a working token can see', async () => {
      const ado = bindable(client());
      const result = await new AdoProvisioningService(ado, projects(), drafts()).preflight(
        'https://x',
        'ok',
      );
      expect(result.ok).toBe(true);
      expect(result.projects).toEqual(['Proj']);
    });

    it("lists a named project's area paths and repositories", async () => {
      const ado = bindable(client());
      const result = await new AdoProvisioningService(ado, projects(), drafts()).preflight(
        'https://x',
        'ok',
        'Proj',
      );
      expect(result.areaPaths).toContain('Proj\\Team A');
      expect(result.repositories).toEqual(['api']);
    });

    /** Typing a project name that is not there must be caught here, not at the first run. */
    it('rejects a project the token cannot see', async () => {
      const ado = bindable(client());
      const result = await new AdoProvisioningService(ado, projects(), drafts()).preflight(
        'https://x',
        'ok',
        'Missing',
      );
      expect(result.ok).toBe(false);
      expect(result.problem).toContain('Missing');
    });

    /** A token may read projects but not repositories; that is a shorter list, not a failure. */
    it('still succeeds when repositories cannot be listed', async () => {
      const ado = bindable(
        client({ listRepositories: jest.fn().mockRejectedValue(new Error('403')) }),
      );
      const result = await new AdoProvisioningService(ado, projects(), drafts()).preflight(
        'https://x',
        'ok',
        'Proj',
      );
      expect(result.ok).toBe(true);
      expect(result.repositories).toEqual([]);
    });
  });

  describe('area path', () => {
    it('creates the area path the project is configured with', async () => {
      const ado = client();
      await new AdoProvisioningService(ado, projects(), drafts()).ensureAreaPath(P);
      expect((ado as unknown as { ensureAreaPath: jest.Mock }).ensureAreaPath).toHaveBeenCalledWith(
        'Proj',
        'Proj\\Team A',
      );
    });

    /** A path given without its project prefix comes back complete, and is stored that way. */
    it('stores the full path when Azure DevOps normalises it', async () => {
      const ado = client({ ensureAreaPath: jest.fn().mockResolvedValue('Proj\\Team A') });
      const svc = projects({
        findById: jest.fn().mockResolvedValue({
          id: P,
          adoTarget: { orgUrl: 'https://x', project: 'Proj', areaPath: 'Team A' },
          targetRepos: [],
        }),
      });
      await new AdoProvisioningService(ado, svc, drafts()).ensureAreaPath(P);
      expect((svc as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith(P, {
        adoTarget: expect.objectContaining({ areaPath: 'Proj\\Team A' }),
      });
    });

    it('does not rewrite a path that was already correct', async () => {
      const svc = projects();
      await new AdoProvisioningService(client(), svc, drafts()).ensureAreaPath(P);
      expect((svc as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });
  });

  describe('repositories', () => {
    it('records the clone URL Azure DevOps reports, not one it assembled', async () => {
      const svc = projects();
      await new AdoProvisioningService(client(), svc, drafts()).ensureRepositories(P, [
        'api',
        'ui',
      ]);
      expect((svc as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith(P, {
        targetRepos: ['https://x/_git/api', 'https://x/_git/ui'],
      });
    });

    /** Re-running configuration must never drop a repository a sprint already points at. */
    it('keeps repositories that were already configured', async () => {
      const svc = projects({
        findById: jest.fn().mockResolvedValue({
          id: P,
          adoTarget: { orgUrl: 'https://x', project: 'Proj', areaPath: 'Proj' },
          targetRepos: ['https://x/_git/existing'],
        }),
      });
      await new AdoProvisioningService(client(), svc, drafts()).ensureRepositories(P, ['api']);
      expect((svc as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith(P, {
        targetRepos: ['https://x/_git/existing', 'https://x/_git/api'],
      });
    });

    it('does not store the same repository twice', async () => {
      const svc = projects({
        findById: jest.fn().mockResolvedValue({
          id: P,
          adoTarget: { orgUrl: 'https://x', project: 'Proj', areaPath: 'Proj' },
          targetRepos: ['https://x/_git/api'],
        }),
      });
      await new AdoProvisioningService(client(), svc, drafts()).ensureRepositories(P, [
        'api',
        ' api ',
      ]);
      expect((svc as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith(P, {
        targetRepos: ['https://x/_git/api'],
      });
    });

    it('refuses to configure nothing', async () => {
      await expect(
        new AdoProvisioningService(client(), projects(), drafts()).ensureRepositories(P, ['  ']),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('configuration', () => {
    const PLAN = [
      '## Architecture',
      '- Expenses are persisted in a database.',
      '- A REST API serves them.',
    ].join('\n');

    /** Before a plan exists nothing can be derived, so nothing is asked. */
    it('asks for nothing while there is no plan', async () => {
      const svc = new AdoProvisioningService(client(), projects(), drafts());
      const config = await svc.configuration(P);
      expect(config.planReady).toBe(false);
      expect(config.needsDatabase).toBe(false);
    });

    it('derives what is needed from the plan', async () => {
      const svc = new AdoProvisioningService(client(), projects(), drafts(PLAN));
      const config = await svc.configuration(P);
      expect(config.planReady).toBe(true);
      expect(config.needsDatabase).toBe(true);
      expect(config.repositories.length).toBeGreaterThan(0);
    });

    it("reports 'unset' as a database nobody chose", async () => {
      const unchosen = projects({
        findById: jest.fn().mockResolvedValue({
          id: P,
          name: 'Expense Tracker',
          adoTarget: { orgUrl: 'https://x', project: 'Proj', areaPath: 'Proj' },
          targetRepos: [],
          database: 'unset',
        }),
      });
      const svc = new AdoProvisioningService(client(), unchosen, drafts(PLAN));
      expect((await svc.configuration(P)).databaseConfigured).toBe(false);
    });

    /**
     * A plan is written against one database. Changing it afterwards makes that plan wrong, and a
     * plan that quietly disagrees with the database is exactly the failure this step exists for.
     */
    it('says the plan needs regenerating when the database changes under it', async () => {
      const svc = new AdoProvisioningService(client(), projects(), drafts(PLAN));
      const result = await svc.applyConfiguration(P, { database: 'postgres' });
      expect(result.replanNeeded).toBe(true);
    });

    it('does not ask for a replan when the database is unchanged', async () => {
      const svc = new AdoProvisioningService(client(), projects(), drafts(PLAN));
      const result = await svc.applyConfiguration(P, { database: 'sqlserver' });
      expect(result.replanNeeded).toBe(false);
    });

    /** Choosing a database before any plan exists cannot invalidate one. */
    it('does not ask for a replan when there is no plan yet', async () => {
      const svc = new AdoProvisioningService(client(), projects(), drafts());
      const result = await svc.applyConfiguration(P, { database: 'postgres' });
      expect(result.replanNeeded).toBe(false);
    });

    it('creates the repositories it was given', async () => {
      const svc = projects();
      await new AdoProvisioningService(client(), svc, drafts(PLAN)).applyConfiguration(P, {
        repositories: ['expense-api'],
      });
      expect((svc as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith(P, {
        targetRepos: ['https://x/_git/expense-api'],
      });
    });

    /** Answering only the database question must not wipe the repositories. */
    it('leaves repositories alone when none were given', async () => {
      const svc = projects();
      await new AdoProvisioningService(client(), svc, drafts(PLAN)).applyConfiguration(P, {
        database: 'mysql',
      });
      const calls = (svc as unknown as { update: jest.Mock }).update.mock.calls;
      expect(calls.every((c: unknown[]) => !(c[1] as { targetRepos?: unknown }).targetRepos)).toBe(
        true,
      );
    });
  });
});

/**
 * Creating the Azure DevOps project for a product.
 *
 * One Azure DevOps project per product, rather than several products sharing one and separated by
 * area path. Area paths separate work items; iterations do not follow them, so products sharing a
 * project also share one sprint timeline — a second product inherits the first one's active sprint,
 * and completing a sprint on one board moves the other's. A project of its own makes the sprints
 * its own, with nothing left to isolate.
 *
 * The process is not a detail: every state the orchestrator writes is Scrum's, so a project made
 * on Agile has its work items created and then never moves them.
 */
describe('AdoProvisioningService creating the Azure DevOps project', () => {
  const PID = '507f1f77bcf86cd799439011';

  const ado = (over: Record<string, unknown> = {}) =>
    adoStub({
      listProjects: jest.fn().mockResolvedValue([{ id: '1', name: 'Something else' }]),
      listProcesses: jest.fn().mockResolvedValue([
        { id: 'agile-id', name: 'Agile' },
        { id: 'scrum-id', name: 'Scrum' },
      ]),
      createProject: jest.fn().mockResolvedValue(undefined),
      ensureAreaPath: jest.fn().mockResolvedValue('Employee Management System'),
      ...over,
    });

  const projectsSvc = () =>
    ({
      create: jest.fn().mockResolvedValue({ id: PID }),
      remove: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue({
        id: PID,
        name: 'Employee Management System',
        adoTarget: {
          orgUrl: 'https://x',
          project: 'Employee Management System',
          areaPath: 'Employee Management System',
        },
        targetRepos: [],
        database: 'unset',
      }),
      update: jest.fn().mockImplementation((_id, patch) => Promise.resolve(patch)),
    }) as unknown as ProjectsService;

  const noDrafts = () => oneDraftStub(null);

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      name: 'Employee Management System',
      description: 'HR tooling',
      createAdoProject: true,
      adoTarget: {
        orgUrl: 'https://x',
        project: 'Employee Management System',
        areaPath: 'Employee Management System',
      },
      ...over,
    }) as never;

  const mockOf = (target: unknown, name: string) => (target as Record<string, jest.Mock>)[name];

  it('creates it on the Scrum process', async () => {
    const client = ado();
    await new AdoProvisioningService(client, projectsSvc(), noDrafts()).provisionProject(
      dto(),
      'user-1',
    );
    expect(mockOf(client, 'createProject')).toHaveBeenCalledWith(
      'Employee Management System',
      'HR tooling',
      'scrum-id',
    );
  });

  /** A project on another process has its work items created and then never moved. */
  it('refuses when the organization has no Scrum process', async () => {
    const client = ado({
      listProcesses: jest.fn().mockResolvedValue([{ id: 'a', name: 'Agile' }]),
    });
    await expect(
      new AdoProvisioningService(client, projectsSvc(), noDrafts()).provisionProject(
        dto(),
        'user-1',
      ),
    ).rejects.toThrow(/Scrum/i);
  });

  it('names the processes the organization does have', async () => {
    const client = ado({
      listProcesses: jest.fn().mockResolvedValue([{ id: 'a', name: 'Agile' }]),
    });
    await expect(
      new AdoProvisioningService(client, projectsSvc(), noDrafts()).provisionProject(
        dto(),
        'user-1',
      ),
    ).rejects.toThrow(/Agile/);
  });

  /** Half-made setup is worse than none: nothing after this step would have a project to act on. */
  it('removes the orchestrator project again when Azure DevOps refuses', async () => {
    const client = ado({
      listProcesses: jest.fn().mockResolvedValue([{ id: 'a', name: 'Agile' }]),
    });
    const svc = projectsSvc();
    await expect(
      new AdoProvisioningService(client, svc, noDrafts()).provisionProject(dto(), 'user-1'),
    ).rejects.toThrow();
    expect(mockOf(svc, 'remove')).toHaveBeenCalledWith(PID);
  });

  it('refuses a name Azure DevOps will not accept', async () => {
    const bad = dto({ adoTarget: { orgUrl: 'https://x', project: 'a/b', areaPath: 'a/b' } });
    await expect(
      new AdoProvisioningService(ado(), projectsSvc(), noDrafts()).provisionProject(bad, 'user-1'),
    ).rejects.toThrow(/cannot contain/i);
  });

  it('refuses to create one that already exists', async () => {
    const client = ado({
      listProjects: jest.fn().mockResolvedValue([{ id: '1', name: 'Employee Management System' }]),
    });
    await expect(
      new AdoProvisioningService(client, projectsSvc(), noDrafts()).provisionProject(
        dto(),
        'user-1',
      ),
    ).rejects.toThrow(/already has/i);
  });

  /** Pointing at an existing project must stay possible, and must not create anything. */
  it('creates nothing when an existing project was chosen', async () => {
    const client = ado();
    await new AdoProvisioningService(client, projectsSvc(), noDrafts()).provisionProject(
      dto({ createAdoProject: false }),
      'user-1',
    );
    expect(mockOf(client, 'createProject')).not.toHaveBeenCalled();
  });
});

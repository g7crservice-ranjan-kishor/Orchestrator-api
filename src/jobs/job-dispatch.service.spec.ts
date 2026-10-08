import { Model } from 'mongoose';
import { AppConfigService } from '../common/config/app-config.service';
import { AppSecretsService } from '../common/secrets/app-secrets.service';
import { DraftDocument } from '../planning/schemas/draft.schema';
import { ExecutionBackend } from './execution-backend';
import { JobDispatchService } from './job-dispatch.service';
import { JobRole, JobState } from './job-state';
import { JobDocument } from './schemas/job.schema';
import { RunTokenService } from '../common/security/run-token.service';
import { SecretsService } from '../common/secrets/secrets.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';

describe('JobDispatchService', () => {
  let execution: { startRun: jest.Mock; cancel: jest.Mock };
  let runTokens: { issue: jest.Mock };
  let secrets: { get: jest.Mock };
  let projects: { findById: jest.Mock };
  let service: JobDispatchService;
  let appSecrets: { readAll: jest.Mock };
  let draftModel: { findOne: jest.Mock };

  const config = {
    port: 3000,
    developerBranch: 'develop',
    gitAuthorName: 'Agentic SDLC Orchestrator',
    gitAuthorEmail: 'agentic-sdlc@noventiqai.com',
    adoMcpConfig: '/app/ado-mcp.json',
    adoOrgUrl: 'https://dev.azure.com/g7crtipl',
    testResultsApi: 'https://dev.azure.com/g7crtipl/_apis/test',
    runHeartbeatMs: 30000,
  } as AppConfigService;

  const projectDoc = {
    id: 'p1',
    adoTarget: {
      orgUrl: 'https://dev.azure.com/g7crtipl',
      project: 'NQAI-DevAutomation',
      areaPath: 'NQAI-DevAutomation\\Agentic SDLC Orchestrator',
    },
  } as unknown as ProjectDocument;

  const job = (over: Partial<JobDocument> = {}): JobDocument =>
    ({
      runId: 'run-1',
      role: JobRole.SM,
      state: JobState.Queued,
      projectId: { toString: () => 'p1' },
      ...over,
    }) as JobDocument;

  beforeEach(() => {
    execution = { startRun: jest.fn().mockResolvedValue(undefined), cancel: jest.fn() };
    runTokens = { issue: jest.fn().mockResolvedValue('tok') };
    secrets = { get: jest.fn().mockResolvedValue(undefined) };
    projects = { findById: jest.fn().mockResolvedValue(projectDoc) };
    appSecrets = { readAll: jest.fn().mockResolvedValue({}) };
    // No draft by default: a project that declared no credentials injects none.
    draftModel = { findOne: jest.fn().mockResolvedValue(null) };
    service = new JobDispatchService(
      execution as unknown as ExecutionBackend,
      runTokens as unknown as RunTokenService,
      secrets as unknown as SecretsService,
      projects as unknown as ProjectsService,
      config,
      appSecrets as unknown as AppSecretsService,
      draftModel as unknown as Model<DraftDocument>,
    );
  });

  describe('adoOrgFromUrl', () => {
    it('extracts the org name from the ADO base URL', () => {
      expect(JobDispatchService.adoOrgFromUrl('https://dev.azure.com/g7crtipl')).toBe('g7crtipl');
      expect(JobDispatchService.adoOrgFromUrl('https://dev.azure.com/g7crtipl/')).toBe('g7crtipl');
    });
    it('returns undefined when no URL is set', () => {
      expect(JobDispatchService.adoOrgFromUrl(undefined)).toBeUndefined();
    });
  });

  it('issues a token and starts the pod without an execution overlay for planning roles', async () => {
    await service.dispatch(job({ role: JobRole.SM }));
    expect(runTokens.issue).toHaveBeenCalledWith('run-1', expect.any(Number));
    const ctx = execution.startRun.mock.calls[0][1];
    expect(ctx.perRunToken).toBe('tok');
    expect(ctx.executionOverlay).toBeUndefined();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  /**
   * Whose Azure DevOps the pod speaks to.
   *
   * A project that brought its own token uses it for everything it does there — work items and
   * cloning alike. Sending half the pod's requests on one organization's credentials and half on
   * another's fails in ways that point at neither.
   */
  describe('project credentials', () => {
    it("uses the project's own token for Azure DevOps and for cloning", async () => {
      secrets.get.mockResolvedValue('platform-creds');
      appSecrets.readAll.mockResolvedValue({ ADO_PAT: 'project-token' });
      await service.dispatch(job({ role: JobRole.Developer }));
      const overlay = execution.startRun.mock.calls[0][1].executionOverlay;
      expect(overlay.adoPat).toBe('project-token');
      expect(overlay.gitCreds).toBe('project-token');
    });

    /** Nothing already configured may stop working: no project token means the platform's. */
    it('falls back to the platform credentials when the project has none', async () => {
      secrets.get.mockResolvedValue('platform-creds');
      appSecrets.readAll.mockResolvedValue({});
      await service.dispatch(job({ role: JobRole.Developer }));
      const overlay = execution.startRun.mock.calls[0][1].executionOverlay;
      expect(overlay.adoPat).toBe('platform-creds');
      expect(overlay.gitCreds).toBe('platform-creds');
    });

    /** A vault outage must not stop a run the platform credentials can still serve. */
    it('falls back when the vault cannot be read', async () => {
      secrets.get.mockResolvedValue('platform-creds');
      appSecrets.readAll.mockRejectedValue(new Error('vault unreachable'));
      await service.dispatch(job({ role: JobRole.Developer }));
      expect(execution.startRun.mock.calls[0][1].executionOverlay.adoPat).toBe('platform-creds');
    });
  });

  it('assembles the execution overlay (config + Key Vault secrets) for developer runs', async () => {
    secrets.get.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'GIT_CREDS' ? 'pat:git' : name === 'ADO_PAT' ? 'pat:ado' : undefined,
      ),
    );
    await service.dispatch(job({ role: JobRole.Developer }));
    const overlay = execution.startRun.mock.calls[0][1].executionOverlay;
    expect(overlay).toMatchObject({
      gitCreds: 'pat:git',
      adoPat: 'pat:ado',
      developerBranch: 'develop',
      gitAuthorName: 'Agentic SDLC Orchestrator',
      adoMcpConfig: '/app/ado-mcp.json',
      adoOrg: 'g7crtipl',
      adoProject: 'NQAI-DevAutomation',
      adoAreaPath: 'NQAI-DevAutomation\\Agentic SDLC Orchestrator',
      runHeartbeatMs: 30000,
    });
    // The developer does not use the Test Results REST fallback (that is a QA-only concern).
    expect(overlay.testResultsApi).toBeUndefined();
  });

  it('assembles a QA execution overlay with ADO/MCP env and read-only repo access', async () => {
    secrets.get.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'GIT_CREDS' ? 'pat:git' : name === 'ADO_PAT' ? 'pat:ado' : undefined,
      ),
    );
    await service.dispatch(job({ role: JobRole.QA }));
    const overlay = execution.startRun.mock.calls[0][1].executionOverlay;
    // QA gets ADO access for the in-pod MCP + Test Plans...
    expect(overlay).toMatchObject({
      adoPat: 'pat:ado',
      adoMcpConfig: '/app/ado-mcp.json',
      adoOrg: 'g7crtipl',
      adoProject: 'NQAI-DevAutomation',
      adoAreaPath: 'NQAI-DevAutomation\\Agentic SDLC Orchestrator',
      testResultsApi: 'https://dev.azure.com/g7crtipl/_apis/test',
      runHeartbeatMs: 30000,
    });
    // ...plus credentials to CLONE the private repo and the branch the Developers push to — a QA
    // pod that cannot read the code cannot test it (the first live QA run failed exactly here).
    expect(overlay.gitCreds).toBe('pat:git');
    expect(overlay.developerBranch).toBe('develop');
    // ...but never a git identity: QA has nothing to commit as, and its run plan never commits.
    expect(overlay.gitAuthorName).toBeUndefined();
    expect(overlay.gitAuthorEmail).toBeUndefined();
  });

  /** Least privilege: a read-only credential is preferred for QA whenever one is configured. */
  it('prefers GIT_CREDS_RO for QA when it is configured', async () => {
    secrets.get.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'GIT_CREDS_RO' ? 'pat:readonly' : name === 'GIT_CREDS' ? 'pat:git' : undefined,
      ),
    );
    await service.dispatch(job({ role: JobRole.QA }));
    expect(execution.startRun.mock.calls[0][1].executionOverlay.gitCreds).toBe('pat:readonly');
  });

  it('never hands a Developer the read-only credential', async () => {
    secrets.get.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'GIT_CREDS_RO' ? 'pat:readonly' : name === 'GIT_CREDS' ? 'pat:git' : undefined,
      ),
    );
    await service.dispatch(job({ role: JobRole.Developer }));
    expect(execution.startRun.mock.calls[0][1].executionOverlay.gitCreds).toBe('pat:git');
  });
});

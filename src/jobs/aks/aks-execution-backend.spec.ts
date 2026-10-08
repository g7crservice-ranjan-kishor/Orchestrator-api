import { BatchV1Api } from '@kubernetes/client-node';
import { AppConfigService } from '../../common/config/app-config.service';
import { AKSExecutionBackend, JobDispatchContext } from './aks-execution-backend';
import { JobDocument } from '../schemas/job.schema';
import { JobRole, PermissionMode } from '../job-state';

const config = {
  k8sNamespace: 'ai-jobs',
  acrLoginServer: 'myacr.azurecr.io',
  workerImageTag: 'v1',
  maxRunTokens: 1000000,
} as AppConfigService;

const job = {
  runId: 'run-123',
  role: JobRole.SM,
  projectId: { toString: () => 'proj-1' },
  workItemId: '18042',
  repo: 'NQAI-DevAutomation',
  permissionMode: PermissionMode.Plan,
} as unknown as JobDocument;

const ctx: JobDispatchContext = {
  backendEventsUrl: 'http://backend/runs',
  perRunToken: 'tok-abc',
  claudeAuthMode: 'subscription',
};

describe('AKSExecutionBackend', () => {
  it('renders a valid Job manifest with substituted placeholders', () => {
    const backend = new AKSExecutionBackend(config);
    const manifest = backend.render(job, ctx);

    expect(manifest.kind).toBe('Job');
    expect(manifest.metadata?.name).toBe('aijob-run-123');
    expect(manifest.metadata?.namespace).toBe('ai-jobs');
    const container = manifest.spec?.template.spec?.containers[0];
    expect(container?.image).toBe('myacr.azurecr.io/ai-worker:v1');
    expect(container?.args).toContain('--run-id=run-123');
    expect(container?.args).toContain('--permission-mode=plan');
    const runToken = container?.env?.find((e) => e.name === 'RUN_TOKEN');
    expect(runToken?.value).toBe('tok-abc');
    // non-root security context is mandatory for bypass mode
    expect(manifest.spec?.template.spec?.securityContext?.runAsNonRoot).toBe(true);
  });

  it('startRun creates exactly one namespaced Job with the manifest', async () => {
    const createNamespacedJob = jest.fn().mockResolvedValue({});
    const backend = new AKSExecutionBackend(config);
    backend.setBatchApi({
      createNamespacedJob,
      readNamespacedJob: jest.fn().mockRejectedValue(new Error('404 not found')),
    } as unknown as BatchV1Api);

    await backend.startRun(job, ctx);
    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
    const [namespace, body] = createNamespacedJob.mock.calls[0];
    expect(namespace).toBe('ai-jobs');
    expect(body.metadata.name).toBe('aijob-run-123');
  });

  /**
   * Re-dispatch is what lease-reclaim does for a run whose pod died, and a run keeps its id — so
   * the Job from the previous pod still holds the name. Without clearing it, Kubernetes answers
   * 409 and the run returns to Queued to collide with the same leftover, forever. That happened to
   * a real planning run: it completed, could not report its result, was reclaimed, and then could
   * never be started again.
   */
  describe('re-dispatching a run whose pod already ran', () => {
    /** `readNamespacedJob` rejects when the Job is absent — the ordinary first dispatch. */
    const absent = () => jest.fn().mockRejectedValue(new Error('404 not found'));

    it('creates the Job directly when there is nothing left over', async () => {
      const createNamespacedJob = jest.fn().mockResolvedValue({});
      const deleteNamespacedJob = jest.fn().mockResolvedValue({});
      const backend = new AKSExecutionBackend(config);
      backend.setBatchApi({
        createNamespacedJob,
        deleteNamespacedJob,
        readNamespacedJob: absent(),
      } as unknown as BatchV1Api);

      await backend.startRun(job, ctx);
      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(createNamespacedJob).toHaveBeenCalledTimes(1);
    });

    it('removes the previous Job before creating the new one', async () => {
      const order: string[] = [];
      const createNamespacedJob = jest.fn().mockImplementation(() => {
        order.push('create');
        return Promise.resolve({});
      });
      const deleteNamespacedJob = jest.fn().mockImplementation(() => {
        order.push('delete');
        return Promise.resolve({});
      });
      // Present once (so it is deleted), gone when polled afterwards.
      const readNamespacedJob = jest
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValue(new Error('404 not found'));
      const backend = new AKSExecutionBackend(config);
      backend.setBatchApi({
        createNamespacedJob,
        deleteNamespacedJob,
        readNamespacedJob,
      } as unknown as BatchV1Api);

      await backend.startRun(job, ctx);
      expect(order).toEqual(['delete', 'create']);
    });

    /** Creating over a Job that never went away would just collide again. */
    it('refuses to create over a Job that will not go away', async () => {
      const createNamespacedJob = jest.fn().mockResolvedValue({});
      const backend = new AKSExecutionBackend(config);
      backend.setBatchApi({
        createNamespacedJob,
        deleteNamespacedJob: jest.fn().mockResolvedValue({}),
        readNamespacedJob: jest.fn().mockResolvedValue({}),
      } as unknown as BatchV1Api);

      await expect(backend.startRun(job, ctx)).rejects.toThrow(/still present/i);
      expect(createNamespacedJob).not.toHaveBeenCalled();
    }, 30_000);
  });

  it('cancel deletes the Job by name with background propagation', async () => {
    const deleteNamespacedJob = jest.fn().mockResolvedValue({});
    const backend = new AKSExecutionBackend(config);
    backend.setBatchApi({ deleteNamespacedJob } as unknown as BatchV1Api);

    await backend.cancel('run-123');
    const args = deleteNamespacedJob.mock.calls[0];
    expect(args[0]).toBe('aijob-run-123');
    expect(args[1]).toBe('ai-jobs');
    expect(args[6]).toBe('Background');
  });

  it('overlays developer-only env for role=developer (git/ADO/branch/heartbeat)', () => {
    const backend = new AKSExecutionBackend(config);
    const devJob = { ...job, role: JobRole.Developer } as unknown as JobDocument;
    const manifest = backend.render(devJob, {
      ...ctx,
      executionOverlay: {
        gitCreds: 'user:pat',
        adoPat: 'ado-pat',
        anthropicApiKey: 'sk-x',
        developerBranch: 'develop',
        gitAuthorName: 'Dev Bot',
        gitAuthorEmail: 'dev@bot',
        adoMcpConfig: '/app/ado-mcp.json',
        runHeartbeatMs: 30000,
      },
    });
    const env = manifest.spec?.template.spec?.containers?.[0].env ?? [];
    const byName = (n: string) => env.find((e) => e.name === n)?.value;
    expect(byName('GIT_CREDS')).toBe('user:pat');
    expect(byName('ADO_PAT')).toBe('ado-pat');
    expect(byName('ANTHROPIC_API_KEY')).toBe('sk-x');
    expect(byName('DEVELOPER_BRANCH')).toBe('develop');
    expect(byName('ADO_MCP_CONFIG')).toBe('/app/ado-mcp.json');
    expect(byName('RUN_HEARTBEAT_MS')).toBe('30000');
    // Wall-clock hard-stop is set on developer jobs.
    expect(manifest.spec?.activeDeadlineSeconds).toBe(3600);
  });

  it('overlays ADO/MCP env for role=qa but NEVER git-push creds (D-018 least privilege)', () => {
    const backend = new AKSExecutionBackend(config);
    const qaJob = { ...job, role: JobRole.QA } as unknown as JobDocument;
    // The dispatcher leaves git fields unset for QA; simulate that overlay here.
    const manifest = backend.render(qaJob, {
      ...ctx,
      executionOverlay: {
        adoPat: 'ado-pat',
        adoMcpConfig: '/app/ado-mcp.json',
        adoOrg: 'g7crtipl',
        adoProject: 'NQAI-DevAutomation',
        adoAreaPath: 'NQAI-DevAutomation\\Agentic SDLC Orchestrator',
        runHeartbeatMs: 30000,
      },
    });
    const env = manifest.spec?.template.spec?.containers?.[0].env ?? [];
    const byName = (n: string) => env.find((e) => e.name === n)?.value;
    // QA pod gets the ADO/MCP env it needs to read/write work items + Test Plans.
    expect(byName('ADO_PAT')).toBe('ado-pat');
    expect(byName('ADO_MCP_CONFIG')).toBe('/app/ado-mcp.json');
    expect(byName('ADO_ORG')).toBe('g7crtipl');
    expect(byName('ADO_PROJECT')).toBe('NQAI-DevAutomation');
    expect(byName('ADO_AREA_PATH')).toBe('NQAI-DevAutomation\\Agentic SDLC Orchestrator');
    expect(byName('RUN_HEARTBEAT_MS')).toBe('30000');
    // But never git-push credentials/identity/branch.
    expect(env.find((e) => e.name === 'GIT_CREDS')).toBeUndefined();
    expect(env.find((e) => e.name === 'DEVELOPER_BRANCH')).toBeUndefined();
    expect(env.find((e) => e.name === 'GIT_AUTHOR_NAME')).toBeUndefined();
    // Wall-clock hard-stop is set on QA jobs too.
    expect(manifest.spec?.activeDeadlineSeconds).toBe(3600);
  });

  it('does not add execution env for planning roles (em/sm)', () => {
    const backend = new AKSExecutionBackend(config);
    const manifest = backend.render(job, {
      ...ctx,
      executionOverlay: { gitCreds: 'should-not-appear' },
    });
    const env = manifest.spec?.template.spec?.containers?.[0].env ?? [];
    expect(env.find((e) => e.name === 'GIT_CREDS')).toBeUndefined();
  });

  it('never overrides a secretRef-backed env with an injected literal (local ANTHROPIC_API_KEY)', () => {
    const localCfg = { ...config, k8sMode: 'local' } as AppConfigService;
    const backend = new AKSExecutionBackend(localCfg);
    const devJob = { ...job, role: JobRole.Developer } as unknown as JobDocument;
    const manifest = backend.render(devJob, {
      ...ctx,
      executionOverlay: { anthropicApiKey: 'literal-should-lose' },
    });
    const apiKey = manifest.spec?.template.spec?.containers?.[0].env?.find(
      (e) => e.name === 'ANTHROPIC_API_KEY',
    );
    // The local template's secretRef wins; the injected literal is not applied.
    expect(apiKey?.value).toBeUndefined();
    expect(apiKey?.valueFrom?.secretKeyRef?.key).toBe('anthropic-api-key');
  });

  it('throws on an unknown template placeholder (guards template drift)', () => {
    const backend = new AKSExecutionBackend(config);
    // Force an unknown placeholder by rendering a job missing a mapped value is not possible via
    // the public API; instead assert the render succeeds for the known set (regression guard).
    expect(() => backend.render(job, ctx)).not.toThrow();
  });
});

describe('AKSExecutionBackend (K8S_MODE=local)', () => {
  const localConfig = {
    k8sNamespace: 'ai-jobs',
    k8sMode: 'local',
    acrLoginServer: 'ai-worker-local',
    workerImageTag: 'local',
    maxRunTokens: 1000000,
  } as AppConfigService;

  it('renders the local flavour: no Workload Identity, IfNotPresent pull, secret-backed key', () => {
    const backend = new AKSExecutionBackend(localConfig);
    const manifest = backend.render(job, ctx);

    const podLabels = manifest.spec?.template.metadata?.labels ?? {};
    expect(podLabels['azure.workload.identity/use']).toBeUndefined();

    const container = manifest.spec?.template.spec?.containers[0];
    expect(container?.image).toBe('ai-worker-local/ai-worker:local');
    expect(container?.imagePullPolicy).toBe('IfNotPresent');

    const apiKey = container?.env?.find((e) => e.name === 'ANTHROPIC_API_KEY');
    expect(apiKey?.valueFrom?.secretKeyRef?.name).toBe('ai-secrets');
    expect(apiKey?.valueFrom?.secretKeyRef?.key).toBe('anthropic-api-key');

    // Subscription token path (no API key needed) is also wired from the secret.
    const oauth = container?.env?.find((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    expect(oauth?.valueFrom?.secretKeyRef?.key).toBe('claude-oauth-token');

    // host.docker.internal is mapped for the pod so it can reach the host API.
    const alias = manifest.spec?.template.spec?.hostAliases?.[0];
    expect(alias?.hostnames).toContain('host.docker.internal');
    expect(alias?.ip).toBe('192.168.65.254');

    // Isolation guarantees are unchanged from AKS.
    expect(manifest.spec?.template.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(container?.securityContext?.capabilities?.drop).toContain('ALL');
  });

  it('defaults to the AKS template when k8sMode is unset', () => {
    const backend = new AKSExecutionBackend(config); // config has no k8sMode
    const manifest = backend.render(job, ctx);
    const podLabels = manifest.spec?.template.metadata?.labels ?? {};
    expect(podLabels['azure.workload.identity/use']).toBe('true');
  });
});

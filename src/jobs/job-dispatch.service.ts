import { Inject, Injectable, Logger } from '@nestjs/common';
import { findActiveDraft } from '../planning/draft-repository';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppConfigService } from '../common/config/app-config.service';
import { AppSecretsService } from '../common/secrets/app-secrets.service';
import { Draft, DraftDocument } from '../planning/schemas/draft.schema';
import { SecretsService } from '../common/secrets/secrets.service';
import { RunTokenService } from '../common/security/run-token.service';
import { ProjectsService } from '../projects/projects.service';
import { EXECUTION_BACKEND, ExecutionBackend, ExecutionOverlayContext } from './execution-backend';
import { JobRole } from './job-state';
import { JobDocument } from './schemas/job.schema';

/** Per-run token lifetime — must exceed the longest possible run (Job activeDeadline is 1h). */
export const RUN_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Single place that turns a persisted job into a running pod (ARCHITECTURE.md §3, §4A): issue the
 * per-run token, assemble the role-aware dispatch context (developer runs carry git/ADO creds + the
 * MCP config, resolved from Key Vault via Workload Identity), and ask the {@link ExecutionBackend}
 * to create the pod. Shared by the human-triggered {@link DevelopmentService} and the lease-reclaim
 * scheduler so **first dispatch and retry-not-resume use the exact same path** — a reclaimed job is
 * re-run as a fresh pod that reconstructs its state from Azure DevOps + git.
 */
@Injectable()
export class JobDispatchService {
  private readonly logger = new Logger(JobDispatchService.name);

  constructor(
    @Inject(EXECUTION_BACKEND) private readonly execution: ExecutionBackend,
    private readonly runTokens: RunTokenService,
    private readonly secrets: SecretsService,
    private readonly projects: ProjectsService,
    private readonly config: AppConfigService,
    private readonly appSecrets: AppSecretsService,
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
  ) {}

  private get backendEventsUrl(): string {
    // The runner posts to `${base}/runs/:id/...`; the API mounts everything under the global
    // `/api` prefix (main.ts), so the base must include it.
    return process.env.BACKEND_EVENTS_URL ?? `http://localhost:${this.config.port}/api`;
  }

  private get claudeAuthMode(): string {
    return process.env.CLAUDE_AUTH_MODE ?? 'subscription';
  }

  /** Extracts the Azure DevOps org name from its base URL (e.g. …/g7crtipl → 'g7crtipl'). */
  static adoOrgFromUrl(orgUrl: string | undefined): string | undefined {
    if (!orgUrl) {
      return undefined;
    }
    const segments = orgUrl.replace(/\/+$/, '').split('/');
    return segments[segments.length - 1] || undefined;
  }

  /**
   * Assembles the extra environment an **execution** pod needs (ARCHITECTURE.md §4A/§4B). Both
   * Developer and QA pods get ADO access for the in-pod ADO MCP (`ADO_PAT`, `ADO_MCP_CONFIG`,
   * `ADO_ORG/PROJECT/AREA_PATH`), the Claude API key in `api` mode, and the heartbeat interval.
   * **Only a Developer** additionally gets git-push credentials + identity + branch — a QA pod
   * reads/writes ADO and Test Plans but never pushes code (D-018). Secrets (`GIT_CREDS`, `ADO_PAT`,
   * `ANTHROPIC_API_KEY`) resolve from Key Vault via Workload Identity — never hardcoded, never
   * logged; a missing optional secret degrades gracefully.
   */
  private async buildExecutionOverlay(job: JobDocument): Promise<ExecutionOverlayContext> {
    const isDeveloper = job.role === JobRole.Developer;
    // Both roles must *read* the repo — an Azure Repos clone of a private repo fails outright
    // without credentials. QA still never writes: the worker's run plan gives it no commit/push step
    // and it receives no git identity. Least privilege is expressed by preferring a **read-only**
    // credential for QA when one is configured (`GIT_CREDS_RO`), falling back to the shared one.
    // A project that brought its own Azure DevOps token uses it for everything the pod does there:
    // reading and writing work items, and cloning. Anything else would send half the pod's requests
    // to one organization's credentials and half to another's. A project without one behaves
    // exactly as it did before this existed.
    const projectPat = await this.projectPat(job);
    const gitCreds =
      projectPat ??
      (isDeveloper
        ? await this.secrets.get('GIT_CREDS')
        : ((await this.secrets.get('GIT_CREDS_RO')) ?? (await this.secrets.get('GIT_CREDS'))));
    const adoPat = projectPat ?? (await this.secrets.get('ADO_PAT'));
    const anthropicApiKey =
      this.claudeAuthMode === 'api' ? await this.secrets.get('ANTHROPIC_API_KEY') : undefined;
    // The ADO target (org/project/areaPath) is a per-project attribute (Job Spec `adoTarget`,
    // ARCHITECTURE.md §6); the org falls back to config when the project's URL omits it.
    const adoTarget = await this.resolveAdoTarget(job);
    return {
      gitCreds,
      adoPat,
      anthropicApiKey,
      // QA tests what the Developers pushed, so it clones the same branch they push to — without
      // this it would clone the repo's default branch and test code that was never written there.
      developerBranch: this.config.developerBranch,
      gitAuthorName: isDeveloper ? this.config.gitAuthorName : undefined,
      gitAuthorEmail: isDeveloper ? this.config.gitAuthorEmail : undefined,
      adoMcpConfig: this.config.adoMcpConfig,
      adoOrg: adoTarget.org,
      adoProject: adoTarget.project,
      adoAreaPath: adoTarget.areaPath,
      // QA pods fall back to the Test Results REST API when the MCP has no test-plan tool (D-020).
      testResultsApi: isDeveloper ? undefined : this.config.testResultsApi,
      runHeartbeatMs: this.config.runHeartbeatMs,
      appSecrets: await this.resolveAppSecrets(job),
      verification: job.role === JobRole.Verify ? await this.resolveVerification(job) : undefined,
    };
  }

  /**
   * The project's own Azure DevOps token, or null when it has none.
   *
   * Never fails a dispatch: a vault that cannot be read must not stop a run that the platform
   * credentials can still serve, which is how every project worked before per-project tokens.
   */
  private async projectPat(job: JobDocument): Promise<string | null> {
    try {
      const found = await this.appSecrets.readAll(job.projectId.toString(), ['ADO_PAT']);
      return found.ADO_PAT?.trim() || null;
    } catch (err) {
      this.logger.warn(
        `Could not read the project token for run ${job.runId}; using the platform credentials: ${
          (err as Error).message
        }`,
      );
      return null;
    }
  }

  /**
   * How to start this product, from the project's own settings.
   *
   * The orchestrator cannot guess the command that starts an arbitrary application, and guessing is
   * how a gate becomes unreliable and then ignored. The defaults suit a Node project; a project that
   * differs says so once, on itself.
   */
  private async resolveVerification(job: JobDocument): Promise<Record<string, string>> {
    const project = await this.projects.findById(job.projectId.toString()).catch(() => null);
    const v = project?.verification;
    return {
      VERIFY_API_START: v?.apiStartCommand || 'npm run dev',
      VERIFY_MIGRATE: v?.migrateCommand || '',
      VERIFY_API_URL: v?.apiUrl || 'http://localhost:3000',
      VERIFY_HEALTH_PATH: v?.healthPath || '/health',
      VERIFY_UI_ORIGIN: v?.uiOrigin || 'http://localhost:5173',
    };
  }

  /**
   * The generated application's own credentials, by the names planning declared, read from Key Vault
   * at dispatch (D-029). Best-effort: a vault that cannot be read must not block the run — the pod
   * then sees the variable as unset, which is a clearer failure than a silent empty value.
   */
  private async resolveAppSecrets(job: JobDocument): Promise<Record<string, string> | undefined> {
    try {
      const projectId = job.projectId.toString();
      const draft = await findActiveDraft(this.draftModel, projectId);
      const names = (draft?.requiredSecrets ?? []).filter((s) => s.provided).map((s) => s.name);
      if (names.length === 0) {
        return undefined;
      }
      return await this.appSecrets.readAll(projectId, names);
    } catch (err) {
      this.logger.warn(
        `Could not resolve application credentials for run ${job.runId}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /** Resolves the developer run's ADO target from its project, falling back to config for the org. */
  private async resolveAdoTarget(
    job: JobDocument,
  ): Promise<{ org?: string; project?: string; areaPath?: string }> {
    try {
      const project = await this.projects.findById(job.projectId.toString());
      const target = project.adoTarget;
      return {
        org:
          JobDispatchService.adoOrgFromUrl(target?.orgUrl) ??
          JobDispatchService.adoOrgFromUrl(this.config.adoOrgUrl),
        project: target?.project,
        areaPath: target?.areaPath,
      };
    } catch (err) {
      // A missing project should not block a retry dispatch; fall back to the config org only.
      this.logger.warn(
        `Could not resolve ADO target for run ${job.runId}: ${(err as Error).message}`,
      );
      return { org: JobDispatchService.adoOrgFromUrl(this.config.adoOrgUrl) };
    }
  }

  /**
   * Issues a fresh per-run token and asks the execution backend to (re)create the pod for `job`.
   * The caller decides how to handle a backend failure (first dispatch leaves the job Queued; the
   * reclaim scheduler retries on the next tick) — this method does not swallow it.
   */
  async dispatch(job: JobDocument): Promise<void> {
    const perRunToken = await this.runTokens.issue(job.runId, RUN_TOKEN_TTL_MS);
    // Execution roles (developer, qa) get the ADO/MCP overlay; planning roles (em, sm) do not.
    const isExecution = job.role === JobRole.Developer || job.role === JobRole.QA;
    const executionOverlay = isExecution ? await this.buildExecutionOverlay(job) : undefined;
    await this.execution.startRun(job, {
      backendEventsUrl: this.backendEventsUrl,
      perRunToken,
      claudeAuthMode: this.claudeAuthMode,
      executionOverlay,
    });
    this.logger.log(`Dispatched pod for run ${job.runId} (role=${job.role})`);
  }
}

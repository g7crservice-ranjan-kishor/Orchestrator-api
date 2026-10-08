import type { JobDocument } from './schemas/job.schema';

/**
 * Extra environment an **execution** pod (Developer or QA) needs beyond a planning pod
 * (ARCHITECTURE.md §4A/§4B). Both roles get ADO access for the in-pod ADO MCP (`adoPat`,
 * `adoMcpConfig`, `adoOrg/Project/AreaPath`), the Claude API key in `api` mode, and the heartbeat
 * interval. **Only the Developer** additionally gets git-push credentials + identity + the target
 * branch — a QA pod reads/writes ADO and Test Plans but never pushes code (D-018,
 * ENVIRONMENT_CONFIGURATION.md §2). Secrets (`gitCreds`, `adoPat`, `anthropicApiKey`) are resolved
 * from Key Vault by the dispatcher and injected per-Job; every field is optional so a missing
 * secret (or a field that does not apply to the role) degrades gracefully rather than blocking
 * dispatch.
 */
export interface ExecutionOverlayContext {
  /** Developer only — git push credentials. Never set for QA. */
  gitCreds?: string;
  adoPat?: string;
  anthropicApiKey?: string;
  /** Developer only — the configured branch to push to. Never set for QA. */
  developerBranch?: string;
  /** Developer only — git commit identity. Never set for QA. */
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  adoMcpConfig?: string;
  /** Azure DevOps target the in-pod ADO MCP scopes to (Job Spec `adoTarget`, ARCHITECTURE.md §6). */
  adoOrg?: string;
  adoProject?: string;
  adoAreaPath?: string;
  /** QA only — Test Results REST API base used when the ADO MCP exposes no test-plan tool (D-020). */
  testResultsApi?: string;
  runHeartbeatMs?: number;
  /**
   * The **generated application's** own runtime credentials, resolved from Key Vault at dispatch
   * (D-029). Distinct from the orchestrator's secrets above: these belong to the product being
   * built, are named during planning and supplied by a human.
   */
  appSecrets?: Record<string, string>;
  /**
   * How to start and reach the product, for a `verify` run: `VERIFY_*` variables read from the
   * project's own settings rather than guessed, so the gate works on any stack.
   */
  verification?: Record<string, string>;
}

/** Per-job runtime context injected when a run is dispatched (not part of the persisted job). */
export interface JobDispatchContext {
  backendEventsUrl: string;
  perRunToken: string;
  claudeAuthMode: string;
  /** Present for execution runs (`role=developer` or `role=qa`); carries the role-aware env overlay. */
  executionOverlay?: ExecutionOverlayContext;
}

/**
 * The execution seam (ARCHITECTURE.md §3): starts and cancels one agent run. Implementations decide
 * *where* the Agent Runner executes — a Kubernetes Job on AKS ({@link AKSExecutionBackend}) or a
 * local child process ({@link LocalExecutionBackend}) for single-box dev/demo. Prompt composition,
 * the model call, and ADO/git writes all happen inside the runner, never here.
 */
export interface ExecutionBackend {
  startRun(job: JobDocument, ctx: JobDispatchContext): Promise<void>;
  cancel(runId: string): Promise<void>;
}

/** DI token for the active {@link ExecutionBackend} (selected by `EXECUTION_BACKEND`). */
export const EXECUTION_BACKEND = Symbol('EXECUTION_BACKEND');

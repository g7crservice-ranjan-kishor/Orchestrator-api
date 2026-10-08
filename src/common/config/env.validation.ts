import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/**
 * Runtime environment. Values are supplied by local settings / Key Vault and validated at
 * bootstrap. See Knowledge Base: ENVIRONMENT_CONFIGURATION.md. Secrets are never hardcoded.
 */
export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Declarative schema for every environment variable the backend consumes. `validateSync` runs
 * once at startup so the process fails fast on a misconfigured environment rather than at first
 * request. Secret values (MONGODB_URI, JWT/SESSION keys, ADO_PAT) are optional here because they
 * resolve from Key Vault at runtime in cloud environments; they are validated where consumed.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(({ value }) => (value === undefined ? 3000 : parseInt(value, 10)))
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT = 3000;

  // --- Persistence -------------------------------------------------------
  @IsString()
  @IsOptional()
  MONGODB_URI?: string;

  // --- Auth secrets (resolved from Key Vault in cloud) -------------------
  @IsString()
  @IsOptional()
  JWT_SIGNING_KEY?: string;

  @IsString()
  @IsOptional()
  SESSION_SECRET?: string;

  @Transform(({ value }) => (value === undefined ? 900 : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  JWT_ACCESS_TTL_SECONDS = 900; // 15 minutes

  @Transform(({ value }) => (value === undefined ? 1209600 : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  SESSION_TTL = 1209600; // 14 days (refresh/session lifetime)

  // --- Azure ------------------------------------------------------------
  @IsString()
  @IsOptional()
  KEY_VAULT_URI?: string;

  @IsString()
  @IsOptional()
  AZURE_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  BLOB_ACCOUNT_URL?: string;

  @IsString()
  @IsOptional()
  BLOB_CONTAINER?: string;

  /**
   * A storage account connection string, for local development only.
   *
   * Takes precedence over `BLOB_ACCOUNT_URL` when both are set. Production uses workload identity
   * and must leave this unset — see the warning `BlobService` logs when it is used.
   */
  @IsString()
  @IsOptional()
  BLOB_CONNECTION_STRING?: string;

  // --- Azure DevOps -----------------------------------------------------
  @IsString()
  @IsOptional()
  ADO_ORG_URL?: string;

  @IsString()
  @IsOptional()
  ADO_PAT?: string;

  // --- Kubernetes / worker image ---------------------------------------
  @IsString()
  @IsOptional()
  K8S_NAMESPACE = 'ai-jobs';

  /** Job-template flavour: 'aks' (Workload Identity + ACR) or 'local' (plain SA + secret + no pull). */
  @IsString()
  @IsOptional()
  K8S_MODE = 'aks';

  @IsString()
  @IsOptional()
  ACR_LOGIN_SERVER?: string;

  @IsString()
  @IsOptional()
  WORKER_IMAGE_TAG?: string;

  // --- Run cost/safety hard-stops --------------------------------------
  @Transform(({ value }) => (value === undefined ? 1000000 : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  MAX_RUN_TOKENS = 1000000;

  @Transform(({ value }) => (value === undefined ? 25 : parseFloat(value)))
  @IsInt()
  @Min(0)
  MAX_RUN_COST = 25;

  // --- Lease / heartbeat -------------------------------------------------
  @Transform(({ value }) => (value === undefined ? 120000 : parseInt(value, 10)))
  @IsInt()
  @Min(1000)
  RUN_LEASE_TTL_MS = 120000;

  @Transform(({ value }) => (value === undefined ? 30000 : parseInt(value, 10)))
  @IsInt()
  @Min(1000)
  RUN_HEARTBEAT_MS = 30000;

  /** Scheduler interval for reclaiming expired job leases (retry-not-resume). Phase 2. */
  @Transform(({ value }) => (value === undefined ? 60000 : parseInt(value, 10)))
  @IsInt()
  @Min(1000)
  RUN_RECLAIM_INTERVAL_MS = 60000;

  // --- Developer execution (Phase 2) -----------------------------------
  /** Azure Repos branch developer pods commit to (no PR gate in Milestone 1). */
  @IsString()
  @IsOptional()
  DEVELOPER_BRANCH = 'develop';

  /** Git identity for developer commits. */
  @IsString()
  @IsOptional()
  GIT_AUTHOR_NAME = 'Agentic SDLC Orchestrator';

  @IsString()
  @IsOptional()
  GIT_AUTHOR_EMAIL = 'agentic-sdlc@noventiqai.com';

  /** In-pod path to the Azure DevOps MCP config the Developer session loads (`--mcp-config`). */
  @IsString()
  @IsOptional()
  ADO_MCP_CONFIG = '/app/ado-mcp.json';

  /**
   * (Phase 3) Test Results REST API base the QA pod uses when the ADO MCP exposes no test-plan tool
   * (D-020). Optional — unset when the MCP test tools are available; work-item state stays the
   * authoritative pass/fail signal regardless. Injected into `role=qa` pods only.
   */
  @IsString()
  @IsOptional()
  TEST_RESULTS_API?: string;

  // --- Orchestration scheduler (Phase 2.1) -----------------------------
  /** Master on/off (pause/stop) switch for the autonomous dispatch scheduler. */
  @Transform(({ value }) => (value === undefined ? false : /^(1|true|yes)$/i.test(String(value))))
  @IsBoolean()
  ORCHESTRATION_ENABLED = false;

  /** Scheduler tick interval (~300000 = 5 min). */
  @Transform(({ value }) => (value === undefined ? 300000 : parseInt(value, 10)))
  @IsInt()
  @Min(1000)
  ORCHESTRATION_INTERVAL_MS = 300000;

  /** Global cap on concurrently dispatched pods; the scheduler dispatches only below it. */
  @Transform(({ value }) => (value === undefined ? 5 : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  MAX_CONCURRENT_RUNS = 5;

  /**
   * Which legs the loop drives, comma-separated. Phase 3 activates the QA leg, so both the
   * Developer and QA legs run by default; override to `developer` to pause QA dispatch.
   */
  @IsString()
  @IsOptional()
  ORCHESTRATION_ROLES = 'developer,qa';
}

/**
 * Validation callback for `@nestjs/config`. Throws (fail-fast) if the environment is invalid.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return validated;
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, NodeEnv } from './env.validation';

/**
 * Typed, single-responsibility accessor over the validated environment. Modules inject this
 * instead of reading `process.env` directly, so there are no stringly-typed lookups and no
 * hardcoded config scattered across the codebase (DEVELOPMENT_GUIDELINES.md §1).
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  private get<K extends keyof EnvironmentVariables>(key: K): EnvironmentVariables[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): NodeEnv {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }

  get port(): number {
    return this.get('PORT');
  }

  get mongoUri(): string | undefined {
    return this.get('MONGODB_URI');
  }

  get jwtSigningKey(): string | undefined {
    return this.get('JWT_SIGNING_KEY');
  }

  get sessionSecret(): string | undefined {
    return this.get('SESSION_SECRET');
  }

  get jwtAccessTtlSeconds(): number {
    return this.get('JWT_ACCESS_TTL_SECONDS');
  }

  get sessionTtlSeconds(): number {
    return this.get('SESSION_TTL');
  }

  get keyVaultUri(): string | undefined {
    return this.get('KEY_VAULT_URI');
  }

  get azureClientId(): string | undefined {
    return this.get('AZURE_CLIENT_ID');
  }

  get blobAccountUrl(): string | undefined {
    return this.get('BLOB_ACCOUNT_URL');
  }

  get blobContainer(): string | undefined {
    return this.get('BLOB_CONTAINER');
  }

  /** A connection string for local development; absent in every deployed environment. */
  get blobConnectionString(): string | undefined {
    return this.get('BLOB_CONNECTION_STRING');
  }

  get adoOrgUrl(): string | undefined {
    return this.get('ADO_ORG_URL');
  }

  get adoPat(): string | undefined {
    return this.get('ADO_PAT');
  }

  get k8sNamespace(): string {
    return this.get('K8S_NAMESPACE');
  }

  /** Job-template flavour: 'aks' (Workload Identity + ACR) or 'local' (plain SA + k8s Secret). */
  get k8sMode(): string {
    return this.get('K8S_MODE');
  }

  get acrLoginServer(): string | undefined {
    return this.get('ACR_LOGIN_SERVER');
  }

  get workerImageTag(): string | undefined {
    return this.get('WORKER_IMAGE_TAG');
  }

  get maxRunTokens(): number {
    return this.get('MAX_RUN_TOKENS');
  }

  get maxRunCost(): number {
    return this.get('MAX_RUN_COST');
  }

  get runLeaseTtlMs(): number {
    return this.get('RUN_LEASE_TTL_MS');
  }

  get runHeartbeatMs(): number {
    return this.get('RUN_HEARTBEAT_MS');
  }

  get runReclaimIntervalMs(): number {
    return this.get('RUN_RECLAIM_INTERVAL_MS');
  }

  // --- Orchestration scheduler (Phase 2.1) ---
  get orchestrationEnabled(): boolean {
    return this.get('ORCHESTRATION_ENABLED');
  }

  get orchestrationIntervalMs(): number {
    return this.get('ORCHESTRATION_INTERVAL_MS');
  }

  get maxConcurrentRuns(): number {
    return this.get('MAX_CONCURRENT_RUNS');
  }

  /** Orchestration legs to drive, parsed + normalised from the comma-separated env value. */
  get orchestrationRoles(): string[] {
    return this.get('ORCHESTRATION_ROLES')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
  }

  /** Azure Repos branch developer pods commit to (no PR gate in M1). */
  get developerBranch(): string {
    return this.get('DEVELOPER_BRANCH');
  }

  get gitAuthorName(): string {
    return this.get('GIT_AUTHOR_NAME');
  }

  get gitAuthorEmail(): string {
    return this.get('GIT_AUTHOR_EMAIL');
  }

  /** In-pod path to the Azure DevOps MCP config the Developer session loads. */
  get adoMcpConfig(): string {
    return this.get('ADO_MCP_CONFIG');
  }

  /** Test Results REST API base for QA pods when the ADO MCP has no test-plan tool (Phase 3, D-020). */
  get testResultsApi(): string | undefined {
    return this.get('TEST_RESULTS_API');
  }
}

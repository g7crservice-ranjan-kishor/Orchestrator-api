import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { AppConfigService } from '../config/app-config.service';

/**
 * Logical secret names. The Key Vault secret name is the same string with `_` replaced by `-`
 * (Key Vault does not allow underscores), e.g. `MONGODB_URI` -> `MONGODB-URI`.
 */
export type SecretName =
  | 'MONGODB_URI'
  | 'JWT_SIGNING_KEY'
  | 'SESSION_SECRET'
  | 'ADO_PAT'
  | 'ANTHROPIC_API_KEY'
  | 'GIT_CREDS'
  /** Read-only git credential for QA pods (D-028 §39: QA reads the repo but never writes). */
  | 'GIT_CREDS_RO';

/**
 * Resolves secrets from Azure Key Vault using Workload Identity (no Kubernetes Secrets, no
 * hardcoded values — ENVIRONMENT_CONFIGURATION.md §4). Resolution order:
 *   1. process.env (local development / values already injected by the platform);
 *   2. Azure Key Vault via {@link DefaultAzureCredential} when `KEY_VAULT_URI` is configured.
 * Values are cached in memory after first resolution. Secret values are never logged.
 */
@Injectable()
export class SecretsService implements OnModuleInit {
  private readonly logger = new Logger(SecretsService.name);
  private client?: SecretClient;
  private readonly cache = new Map<string, string>();

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    const vaultUri = this.config.keyVaultUri;
    if (!vaultUri) {
      this.logger.log('KEY_VAULT_URI not set — resolving secrets from the environment only.');
      return;
    }
    // managedIdentityClientId ties the credential to the workload identity when running in-cluster.
    const credential = new DefaultAzureCredential(
      this.config.azureClientId ? { managedIdentityClientId: this.config.azureClientId } : {},
    );
    this.client = new SecretClient(vaultUri, credential);
    this.logger.log('Key Vault client initialised (Workload Identity).');
  }

  /** Maps a logical secret name to its Key Vault secret name. */
  private toVaultName(name: SecretName): string {
    return name.replace(/_/g, '-');
  }

  /**
   * Returns the secret value, or `undefined` if it cannot be resolved. Env wins over Key Vault so
   * local development needs no vault access.
   */
  async get(name: SecretName): Promise<string | undefined> {
    const fromEnv = process.env[name];
    if (fromEnv) {
      return fromEnv;
    }
    if (this.cache.has(name)) {
      return this.cache.get(name);
    }
    if (!this.client) {
      return undefined;
    }
    try {
      const secret = await this.client.getSecret(this.toVaultName(name));
      if (secret.value) {
        this.cache.set(name, secret.value);
      }
      return secret.value;
    } catch (err) {
      this.logger.error(
        `Failed to resolve secret '${name}' from Key Vault: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Returns the secret value or throws if it is not resolvable. Use for secrets that are mandatory
   * for the current runtime (fail-fast rather than silently degrade).
   */
  async require(name: SecretName): Promise<string> {
    const value = await this.get(name);
    if (!value) {
      throw new Error(
        `Required secret '${name}' is not available (checked environment and Key Vault).`,
      );
    }
    return value;
  }
}

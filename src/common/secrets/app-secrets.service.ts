import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import { AppConfigService } from '../config/app-config.service';

/** Key Vault secret names allow letters, digits and dashes only. */
const VAULT_NAME = /^[A-Za-z0-9-]+$/;

/** Environment-variable names an application may declare: `DATABASE_URL`, `JWT_SECRET`, … */
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Store for the **generated application's own credentials** — the values a human supplies during
 * planning so the built app can reach its database and any external service.
 *
 * Deliberately distinct from {@link SecretsService}, which resolves the *orchestrator's* own
 * secrets from a fixed, compile-time list. These are per-project, named at runtime by the planning
 * agent, and supplied by a person.
 *
 * Two rules the rest of the system depends on:
 *
 * 1. **Values never touch MongoDB.** They are written straight to Key Vault (the project's standing
 *    rule: no secrets in repo/Mongo). The draft records only the *name* and whether it is set.
 * 2. **Write-only from the outside.** Nothing in the HTTP API can read a value back; the only
 *    reader is {@link readAll}, used at dispatch to inject the values into a pod's environment.
 */
@Injectable()
export class AppSecretsService {
  private readonly logger = new Logger(AppSecretsService.name);
  private client?: SecretClient;

  constructor(private readonly config: AppConfigService) {}

  private vault(): SecretClient {
    if (!this.client) {
      const vaultUri = this.config.keyVaultUri;
      if (!vaultUri) {
        throw new ServiceUnavailableException(
          'KEY_VAULT_URI is not configured, so application credentials cannot be stored securely.',
        );
      }
      const credential = new DefaultAzureCredential(
        this.config.azureClientId ? { managedIdentityClientId: this.config.azureClientId } : {},
      );
      this.client = new SecretClient(vaultUri, credential);
    }
    return this.client;
  }

  /**
   * Key Vault name for one project-scoped application secret. Underscores are not legal in vault
   * names, so `DATABASE_URL` for project `abc` becomes `app-abc-DATABASE-URL`. The project id keeps
   * two projects' `DATABASE_URL` apart in a shared vault.
   */
  static vaultNameFor(projectId: string, envName: string): string {
    const name = `app-${projectId}-${envName.replace(/_/g, '-')}`;
    if (!VAULT_NAME.test(name)) {
      throw new Error(`'${envName}' cannot be mapped to a valid Key Vault secret name.`);
    }
    return name;
  }

  /**
   * Turns a Key Vault failure into something the person at the screen can act on.
   *
   * Storing a credential is the first thing in the product that needs the vault, so a misconfigured
   * identity shows up here first — and as a bare 500 it says nothing at all. The two failures that
   * actually happen are "cannot authenticate" and "authenticated but not allowed", and they need
   * different fixes, so they are named separately.
   */
  private vaultFailure(envName: string, err: unknown): ServiceUnavailableException {
    const failure = err as { name?: string; statusCode?: number; message?: string };
    this.logger.error(`Could not store ${envName} in Key Vault: ${failure.message ?? err}`);

    const unauthenticated =
      failure.statusCode === 401 ||
      failure.name === 'AggregateAuthenticationError' ||
      failure.name === 'CredentialUnavailableError' ||
      failure.name === 'AuthenticationError';
    if (unauthenticated) {
      return new ServiceUnavailableException(
        `${envName} was not stored: the orchestrator could not sign in to Key Vault. ` +
          'Sign it in to Azure (run `az login` for a local API, or check the workload identity in ' +
          'the cluster) and save again.',
      );
    }

    if (failure.statusCode === 403) {
      return new ServiceUnavailableException(
        `${envName} was not stored: the orchestrator's identity is not allowed to write secrets to ` +
          'the key vault. Grant it the Key Vault Secrets Officer role, or `set` permission in the ' +
          "vault's access policy, and save again.",
      );
    }

    return new ServiceUnavailableException(
      `${envName} was not stored: Key Vault rejected the request (${failure.message ?? 'unknown error'}).`,
    );
  }

  /** Stores (or replaces) one application credential. The value is never logged or returned. */
  async set(projectId: string, envName: string, value: string): Promise<void> {
    if (!ENV_NAME.test(envName)) {
      throw new Error(`'${envName}' is not a valid environment variable name.`);
    }
    try {
      await this.vault().setSecret(AppSecretsService.vaultNameFor(projectId, envName), value);
    } catch (err) {
      // A ServiceUnavailableException from vault() already says what is wrong; keep it.
      throw err instanceof ServiceUnavailableException ? err : this.vaultFailure(envName, err);
    }
    // The name is safe to log; the value must never appear anywhere.
    this.logger.log(`Stored application credential ${envName} for project ${projectId}.`);
  }

  /** Removes one credential. Absent is treated as removed — the caller wants it gone either way. */
  async remove(projectId: string, envName: string): Promise<void> {
    try {
      const poller = await this.vault().beginDeleteSecret(
        AppSecretsService.vaultNameFor(projectId, envName),
      );
      await poller.pollUntilDone();
    } catch (err) {
      this.logger.warn(
        `Could not delete application credential ${envName} for ${projectId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Resolves every declared credential for a project, for injection into a pod's environment.
   * **The only read path.** A name with no stored value is skipped rather than injected empty, so a
   * missing credential surfaces as "variable not set" in the app rather than a silent blank.
   */
  /**
   * Which of these credentials the project already holds a value for.
   *
   * The vault is keyed by **project**, while a draft's `requiredSecrets` list is per *plan* — so an
   * enhancement declaring `DATABASE_URL` is declaring something the project very likely already has.
   * Without this it is asked for again, and a person is invited to re-enter a connection string
   * that is sitting in the vault already.
   *
   * Returns names only. The values are not wanted here and are not held.
   */
  async existing(projectId: string, envNames: string[]): Promise<string[]> {
    const present: string[] = [];
    for (const envName of envNames) {
      try {
        const secret = await this.vault().getSecret(
          AppSecretsService.vaultNameFor(projectId, envName),
        );
        if (secret.value) present.push(envName);
      } catch {
        // Absent, or unreadable — either way the project cannot be said to hold it.
      }
    }
    return present;
  }

  async readAll(projectId: string, envNames: string[]): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const envName of envNames) {
      try {
        const secret = await this.vault().getSecret(
          AppSecretsService.vaultNameFor(projectId, envName),
        );
        if (secret.value) {
          resolved[envName] = secret.value;
        }
      } catch (err) {
        this.logger.warn(
          `Application credential ${envName} is declared for ${projectId} but could not be read: ${
            (err as Error).message
          }`,
        );
      }
    }
    return resolved;
  }
}

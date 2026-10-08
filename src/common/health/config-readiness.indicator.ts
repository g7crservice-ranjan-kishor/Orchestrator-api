import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { AppConfigService } from '../config/app-config.service';

/**
 * Reports whether an external integration is configured for the current runtime. In cloud
 * environments the corresponding secret/endpoint must be present; locally these may be absent
 * (the service degrades rather than failing liveness). Deep connectivity checks for Key Vault and
 * the K8s API are layered on by their owning modules as they are implemented.
 */
@Injectable()
export class ConfigReadinessIndicator extends HealthIndicator {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  keyVault(): HealthIndicatorResult {
    const configured = Boolean(this.config.keyVaultUri);
    // In production Key Vault is mandatory; locally it is optional.
    const healthy = configured || !this.config.isProduction;
    return this.getStatus('keyVault', healthy, { configured });
  }

  kubernetes(): HealthIndicatorResult {
    const configured = Boolean(this.config.k8sNamespace);
    return this.getStatus('kubernetes', configured, {
      namespace: this.config.k8sNamespace,
    });
  }
}

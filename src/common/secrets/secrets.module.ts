import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service';
import { AppSecretsService } from './app-secrets.service';

/** Global secrets access via Key Vault + Workload Identity (with env fallback for local dev). */
@Global()
@Module({
  providers: [SecretsService, AppSecretsService],
  exports: [SecretsService, AppSecretsService],
})
export class SecretsModule {}

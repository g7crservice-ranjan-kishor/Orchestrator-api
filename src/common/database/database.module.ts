import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { SecretsModule } from '../secrets/secrets.module';
import { SecretsService } from '../secrets/secrets.service';

/**
 * MongoDB connection wired from the typed config. The connection string is a secret and resolves
 * from the environment or Key Vault via {@link SecretsService} — never hardcoded
 * (ENVIRONMENT_CONFIGURATION.md §4).
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [AppConfigModule, SecretsModule],
      inject: [AppConfigService, SecretsService],
      useFactory: async (config: AppConfigService, secrets: SecretsService) => ({
        uri: await secrets.get('MONGODB_URI'),
        autoIndex: !config.isProduction,
      }),
    }),
  ],
})
export class DatabaseModule {}

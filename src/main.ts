import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './common/config/app-config.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildValidationPipe } from './common/validation/validation-pipe.factory';
import { setupSwagger, SWAGGER_PATH } from './common/swagger/setup-swagger';

/**
 * Application entrypoint. Applies the mandatory backend baseline: structured logging, global
 * validation, global exception handling, security headers, and Swagger docs
 * (DEVELOPMENT_GUIDELINES.md §1).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Structured logging (nestjs-pino) as the app logger.
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(buildValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api');

  setupSwagger(app);

  await app.listen(config.port);

  const logger = app.get(Logger);
  logger.log(
    `Orchestrator API listening on port ${config.port} (docs at /${SWAGGER_PATH})`,
    'Bootstrap',
  );
}

void bootstrap();

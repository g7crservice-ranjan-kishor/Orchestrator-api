import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Route the interactive OpenAPI docs are served from. */
export const SWAGGER_PATH = 'docs';

/**
 * Configures Swagger/OpenAPI for all REST endpoints (DEVELOPMENT_GUIDELINES §1). Registers a
 * bearer-auth scheme (JWT access token) and a session cookie scheme so protected routes can be
 * exercised from the docs UI.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Agentic SDLC Orchestrator API')
    .setDescription(
      'Control-plane REST API for the Agentic SDLC Orchestrator (Phase 1 — Planning MVP).',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addCookieAuth('sid')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}

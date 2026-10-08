import { ValidationPipe } from '@nestjs/common';

/**
 * Builds the global {@link ValidationPipe} applied to every request (DEVELOPMENT_GUIDELINES §1).
 * - `whitelist` + `forbidNonWhitelisted`: reject any property not declared on the DTO.
 * - `transform`: instantiate DTO classes and coerce primitive types.
 * The pipe throws a `BadRequestException`, which the global exception filter renders as the
 * standard error envelope.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    forbidUnknownValues: true,
  });
}

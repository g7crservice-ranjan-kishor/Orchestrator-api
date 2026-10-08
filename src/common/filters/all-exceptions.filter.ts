import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CORRELATION_ID_HEADER } from '../logging/logging.constants';
import { ENVELOPE_DETAIL_KEYS, ErrorEnvelope } from './error-envelope.dto';

/**
 * Global exception filter producing the consistent {@link ErrorEnvelope} shape for all errors.
 * HTTP exceptions preserve their status and message; anything else is normalised to a 500 without
 * leaking internal details or secrets (DEVELOPMENT_GUIDELINES.md §2, §3). Every response carries
 * the request correlation id so a client error can be tied back to a log line.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const { status, message, error, details } = this.normalise(exception);

    const correlationId =
      request.id ?? (request.headers[CORRELATION_ID_HEADER] as string | undefined) ?? 'unknown';

    const envelope: ErrorEnvelope = {
      statusCode: status,
      message,
      error,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
      // A refusal that says "2 validation error(s)" and stops is a puzzle. When a guard
      // explains itself, that explanation has to survive as far as the client.
      ...details,
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, correlationId, path: request.url },
        `Unhandled exception: ${error}`,
      );
    } else {
      this.logger.warn({ correlationId, path: request.url, status }, `Request error: ${error}`);
    }

    response.status(status).json(envelope);
  }

  /** Picks only the known detail fields off an exception body. */
  private detailsOf(body: Record<string, unknown>): Record<string, unknown> {
    const details: Record<string, unknown> = {};
    for (const key of ENVELOPE_DETAIL_KEYS) {
      if (body[key] !== undefined) details[key] = body[key];
    }
    return details;
  }

  private normalise(exception: unknown): {
    status: number;
    message: string | string[];
    error: string;
    details: Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        return { status, message: res, error: exception.name, details: {} };
      }
      const body = res as { message?: string | string[]; error?: string };
      return {
        status,
        message: body.message ?? exception.message,
        error: body.error ?? exception.name,
        details: this.detailsOf(res as Record<string, unknown>),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
      details: {},
    };
  }
}

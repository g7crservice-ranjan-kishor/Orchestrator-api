import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { CORRELATION_ID_FIELD, CORRELATION_ID_HEADER, RUN_ID_HEADER } from './logging.constants';

/**
 * Structured (JSON) logging with a per-request `runId` correlation field (DEVELOPMENT_GUIDELINES
 * §1). Every request is stamped with a correlation id — taken from the run/correlation headers
 * when present (so Agent-Runner event POSTs trace end-to-end) or generated otherwise — and echoed
 * back on the response. Secret-bearing headers and fields are redacted so nothing sensitive is
 * ever logged (ENVIRONMENT_CONFIGURATION.md §4).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.isProduction ? 'info' : 'debug',
          // Pretty-print only in local development; JSON everywhere else.
          transport:
            config.isProduction || config.isTest
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
          autoLogging: !config.isTest,
          genReqId: (req: IncomingMessage, res: ServerResponse): string => {
            const existing =
              (req.headers[RUN_ID_HEADER] as string | undefined) ??
              (req.headers[CORRELATION_ID_HEADER] as string | undefined);
            const id = existing ?? randomUUID();
            res.setHeader(CORRELATION_ID_HEADER, id);
            return id;
          },
          customProps: (req: IncomingMessage): Record<string, unknown> => ({
            [CORRELATION_ID_FIELD]: (req as IncomingMessage & { id?: unknown }).id,
          }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              `req.headers["${RUN_ID_HEADER}"]`,
              'req.headers["x-run-token"]',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwordHash',
              '*.token',
              '*.secret',
              '*.pat',
              '*.ADO_PAT',
              '*.MONGODB_URI',
            ],
            censor: '[redacted]',
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}

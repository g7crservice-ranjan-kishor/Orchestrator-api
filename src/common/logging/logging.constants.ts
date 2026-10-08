/** Header carrying a run correlation id from the Agent Runner event stream. */
export const RUN_ID_HEADER = 'x-run-id';

/** Header carrying a generic request correlation id. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Property name used for the correlation field on every structured log line. */
export const CORRELATION_ID_FIELD = 'runId';

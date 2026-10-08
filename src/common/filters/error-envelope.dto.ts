import { ApiProperty } from '@nestjs/swagger';

/**
 * Consistent error envelope returned for every unhandled/HTTP error
 * (DEVELOPMENT_GUIDELINES.md §3).
 */
/**
 * Fields a guard may attach to its exception body to explain a refusal. Whitelisted rather than
 * passed through wholesale: an exception body can contain anything, and this envelope is the one
 * shape every client relies on.
 */
export const ENVELOPE_DETAIL_KEYS = [
  'reason',
  'errors',
  'missingSprints',
  'availableSprints',
] as const;

export class ErrorEnvelope {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    description: 'Human-readable message(s).',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Validation failed',
  })
  message!: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({
    description: 'Correlation id for tracing this response in the logs.',
    example: '3f0b8c1e-9d2a-4a5b-8c1e-9d2a4a5b8c1e',
  })
  correlationId!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;

  @ApiProperty({ example: '/auth/login' })
  path!: string;
}

import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * The single error shape every client relies on: status, message, error, correlation id, path —
 * and, for a guard that explains itself, the specifics of the refusal.
 *
 * The gap the detail tests close: a push refusal carrying the exact backlog errors arrived at the
 * client as `Backlog has 2 validation error(s); cannot push.` and nothing else, because `normalise`
 * copied only `message` and `error` off the exception body. A refusal that names a count and stops
 * is a puzzle, not a gate.
 */
describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  function capture(exception: unknown, request: Record<string, unknown> = {}) {
    let body: Record<string, unknown> = {};
    let code = 0;
    const response = {
      status: (status: number) => {
        code = status;
        return { json: (payload: Record<string, unknown>) => (body = payload) };
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: '/api/test', headers: {}, id: 'cid-1', ...request }),
      }),
    };
    filter.catch(exception, host as never);
    return { code, body };
  }

  describe('the envelope', () => {
    it('carries status, message, error, correlation id and path', () => {
      const { code, body } = capture(new NotFoundException('No such project.'));
      expect(code).toBe(HttpStatus.NOT_FOUND);
      expect(body).toMatchObject({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No such project.',
        correlationId: 'cid-1',
        path: '/api/test',
      });
      expect(typeof body.timestamp).toBe('string');
    });

    it('preserves the status of each HTTP exception', () => {
      expect(capture(new ForbiddenException()).code).toBe(HttpStatus.FORBIDDEN);
      expect(capture(new BadRequestException()).code).toBe(HttpStatus.BAD_REQUEST);
      expect(capture(new InternalServerErrorException()).code).toBe(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    });

    /** Validation pipes throw an array of messages; it must survive as an array. */
    it('keeps an array message intact', () => {
      const { body } = capture(
        new BadRequestException({ message: ['email must be an email', 'password is required'] }),
      );
      expect(body.message).toEqual(['email must be an email', 'password is required']);
    });

    it('falls back to the header correlation id when the request has no id', () => {
      const { body } = capture(new BadRequestException('x'), {
        id: undefined,
        headers: { 'x-correlation-id': 'from-header' },
      });
      expect(body.correlationId).toBe('from-header');
    });

    it('reports an unknown correlation id rather than failing', () => {
      const { body } = capture(new BadRequestException('x'), { id: undefined, headers: {} });
      expect(body.correlationId).toBe('unknown');
    });
  });

  describe('an unexpected failure', () => {
    /** Never leak internals or secrets through an error path. */
    it('becomes a bare 500 that reveals nothing', () => {
      const { code, body } = capture(new Error('connect sqlserver://sa:hunter2@db:1433'));
      expect(code).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(JSON.stringify(body)).not.toContain('sqlserver');
    });

    it('normalises a thrown non-Error the same way', () => {
      const { code, body } = capture('something odd');
      expect(code).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe('Internal server error');
    });
  });

  describe('refusal detail', () => {
    it('keeps the specific problems a guard attached', () => {
      const { body } = capture(
        new BadRequestException({
          message: 'Backlog has 2 validation error(s); cannot push.',
          reason: 'invalid-backlog',
          errors: ['Verify CORS — repository is not one of the project repositories.', 'Second.'],
        }),
      );
      expect(body.reason).toBe('invalid-backlog');
      expect(body.errors).toHaveLength(2);
      expect(String((body.errors as string[])[0])).toContain('Verify CORS');
    });

    it('keeps the sprints a push refusal names as missing', () => {
      const { body } = capture(
        new BadRequestException({
          message: 'The backlog targets 1 sprint(s) that do not exist.',
          reason: 'missing-iterations',
          missingSprints: ['Sprint 4'],
          availableSprints: ['Sprint 1', 'Sprint 2'],
        }),
      );
      expect(body.missingSprints).toEqual(['Sprint 4']);
      expect(body.availableSprints).toEqual(['Sprint 1', 'Sprint 2']);
    });

    /** Whitelisted, not passed through wholesale: an exception body is not part of the contract. */
    it('does not let arbitrary fields into the envelope', () => {
      const { body } = capture(
        new BadRequestException({ message: 'no', stack: 'secret', internalQuery: 'select *' }),
      );
      expect(body.stack).toBeUndefined();
      expect(body.internalQuery).toBeUndefined();
    });

    it('adds nothing when the exception is a plain string', () => {
      const { body } = capture(new BadRequestException('Just a message.'));
      expect(body.message).toBe('Just a message.');
      expect(body.reason).toBeUndefined();
      expect(body.errors).toBeUndefined();
    });
  });
});

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RunEventDto } from './run-event.dto';

/** Validates the streaming event contract (api/runs-events.md). */
function validate(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(RunEventDto, payload);
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('RunEventDto contract', () => {
  it('accepts a running lifecycle event', () => {
    expect(validate({ type: 'running', at: '2026-07-21T00:00:00Z' })).toHaveLength(0);
  });

  it('accepts a heartbeat event', () => {
    expect(validate({ type: 'heartbeat' })).toHaveLength(0);
  });

  it('requires message on a log event', () => {
    expect(validate({ type: 'log', level: 'info' }).length).toBeGreaterThan(0);
    expect(validate({ type: 'log', message: 'hello' })).toHaveLength(0);
  });

  it('requires name on a tool event', () => {
    expect(validate({ type: 'tool' }).length).toBeGreaterThan(0);
    expect(validate({ type: 'tool', name: 'edit_file', target: 'src/x.ts' })).toHaveLength(0);
  });

  it('requires workItem on an ado event', () => {
    expect(validate({ type: 'ado', from: 'Committed', to: 'Done' }).length).toBeGreaterThan(0);
    expect(validate({ type: 'ado', workItem: 1234, from: 'Committed', to: 'Done' })).toHaveLength(
      0,
    );
  });

  it('requires a valid status on a result event', () => {
    expect(validate({ type: 'result' }).length).toBeGreaterThan(0);
    expect(validate({ type: 'result', status: 'Nope' }).length).toBeGreaterThan(0);
    expect(
      validate({ type: 'result', status: 'Completed', durationMs: 10, tokens: 5, cost: 0.1 }),
    ).toHaveLength(0);
  });

  it('rejects an unknown event type', () => {
    expect(validate({ type: 'explode' }).length).toBeGreaterThan(0);
  });

  it('rejects negative numeric metrics', () => {
    expect(validate({ type: 'result', status: 'Completed', tokens: -1 }).length).toBeGreaterThan(0);
  });
});

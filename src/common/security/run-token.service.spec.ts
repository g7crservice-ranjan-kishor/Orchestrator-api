import { RunTokenService } from './run-token.service';
import { AppConfigService } from '../config/app-config.service';
import { SecretsService } from '../secrets/secrets.service';

function makeService(): RunTokenService {
  const config = { runLeaseTtlMs: 120000 } as AppConfigService;
  const secrets = {
    require: jest.fn().mockResolvedValue('test-signing-secret'),
  } as unknown as SecretsService;
  return new RunTokenService(config, secrets);
}

describe('RunTokenService', () => {
  it('issues a token that verifies for the same runId', async () => {
    const service = makeService();
    const token = await service.issue('run-1', 60000, 1000);
    await expect(service.verify('run-1', token, 2000)).resolves.toBe(true);
  });

  it('rejects a token for a different runId', async () => {
    const service = makeService();
    const token = await service.issue('run-1', 60000, 1000);
    await expect(service.verify('run-2', token, 2000)).resolves.toBe(false);
  });

  it('rejects an expired token', async () => {
    const service = makeService();
    const token = await service.issue('run-1', 1000, 1000); // expires at 2000
    await expect(service.verify('run-1', token, 5000)).resolves.toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const service = makeService();
    const token = await service.issue('run-1', 60000, 1000);
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    await expect(service.verify('run-1', tampered, 2000)).resolves.toBe(false);
  });

  it('rejects a missing or malformed token', async () => {
    const service = makeService();
    await expect(service.verify('run-1', undefined, 2000)).resolves.toBe(false);
    await expect(service.verify('run-1', 'garbage', 2000)).resolves.toBe(false);
  });
});

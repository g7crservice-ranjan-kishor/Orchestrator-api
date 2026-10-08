import { SecretsService } from './secrets.service';
import { AppConfigService } from '../config/app-config.service';

function makeConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    keyVaultUri: undefined,
    azureClientId: undefined,
    isProduction: false,
    ...overrides,
  } as AppConfigService;
}

describe('SecretsService', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('resolves a secret from the environment before touching Key Vault', async () => {
    process.env.JWT_SIGNING_KEY = 'env-key';
    const service = new SecretsService(makeConfig());
    service.onModuleInit(); // no vault configured
    await expect(service.get('JWT_SIGNING_KEY')).resolves.toBe('env-key');
  });

  it('returns undefined when neither env nor Key Vault can resolve the secret', async () => {
    delete process.env.ADO_PAT;
    const service = new SecretsService(makeConfig());
    service.onModuleInit();
    await expect(service.get('ADO_PAT')).resolves.toBeUndefined();
  });

  it('require() throws a non-secret-leaking error when unresolved', async () => {
    delete process.env.MONGODB_URI;
    const service = new SecretsService(makeConfig());
    service.onModuleInit();
    await expect(service.require('MONGODB_URI')).rejects.toThrow(
      /Required secret 'MONGODB_URI' is not available/,
    );
  });

  it('resolves from a mocked Key Vault client when env is absent', async () => {
    delete process.env.SESSION_SECRET;
    const service = new SecretsService(makeConfig({ keyVaultUri: 'https://kv.example' }));
    // Inject a fake client (bypass real Azure SDK / network).
    (service as unknown as { client: { getSecret: jest.Mock } }).client = {
      getSecret: jest.fn().mockResolvedValue({ value: 'vault-secret' }),
    };
    await expect(service.get('SESSION_SECRET')).resolves.toBe('vault-secret');
    // Cached on second call (client called once).
    await service.get('SESSION_SECRET');
    const client = (service as unknown as { client: { getSecret: jest.Mock } }).client;
    expect(client.getSecret).toHaveBeenCalledTimes(1);
    expect(client.getSecret).toHaveBeenCalledWith('SESSION-SECRET');
  });
});

import { NodeEnv, validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults when optional variables are absent', () => {
    const result = validateEnv({});
    expect(result.NODE_ENV).toBe(NodeEnv.Development);
    expect(result.PORT).toBe(3000);
    expect(result.K8S_NAMESPACE).toBe('ai-jobs');
    expect(result.MAX_RUN_TOKENS).toBe(1000000);
    expect(result.RUN_LEASE_TTL_MS).toBe(120000);
    expect(result.RUN_HEARTBEAT_MS).toBe(30000);
  });

  it('coerces numeric strings into numbers', () => {
    const result = validateEnv({ PORT: '8080', MAX_RUN_TOKENS: '500000' });
    expect(result.PORT).toBe(8080);
    expect(result.MAX_RUN_TOKENS).toBe(500000);
  });

  it('accepts a valid NODE_ENV', () => {
    const result = validateEnv({ NODE_ENV: 'production' });
    expect(result.NODE_ENV).toBe(NodeEnv.Production);
  });

  it('throws on an out-of-range port', () => {
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/Invalid environment configuration/);
  });

  it('throws on an unknown NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('does not require secret values (they resolve from Key Vault)', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).not.toThrow();
  });
});

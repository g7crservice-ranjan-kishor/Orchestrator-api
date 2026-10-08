import { ServiceUnavailableException } from '@nestjs/common';
import { AppSecretsService, ENV_NAME } from './app-secrets.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * The generated application's own credentials (D-029). Two properties matter more than the
 * plumbing: a value must never be derivable from a name collision between projects, and a name the
 * planning agent invents must never produce an invalid Key Vault request.
 */
describe('AppSecretsService.vaultNameFor', () => {
  const PROJECT = '6aaa363961610d4d4107c5cf';

  it('scopes the secret to its project so two projects never collide', () => {
    const a = AppSecretsService.vaultNameFor('projecta', 'DATABASE_URL');
    const b = AppSecretsService.vaultNameFor('projectb', 'DATABASE_URL');
    expect(a).not.toBe(b);
  });

  /** Key Vault names allow letters, digits and dashes only — an underscore is rejected outright. */
  it('maps underscores to dashes, which Key Vault requires', () => {
    expect(AppSecretsService.vaultNameFor(PROJECT, 'DATABASE_URL')).toBe(
      `app-${PROJECT}-DATABASE-URL`,
    );
  });

  it('produces a name Key Vault accepts', () => {
    const name = AppSecretsService.vaultNameFor(PROJECT, 'JWT_SIGNING_SECRET');
    expect(name).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('refuses a name that cannot be mapped safely', () => {
    expect(() => AppSecretsService.vaultNameFor(PROJECT, 'DB.PASSWORD')).toThrow();
    expect(() => AppSecretsService.vaultNameFor(PROJECT, 'DB PASSWORD')).toThrow();
  });
});

/**
 * What the person saving a credential is told when the vault refuses.
 *
 * The first save on a new environment is where a misconfigured identity surfaces, and the two
 * causes need different fixes — sign the API in, or grant it permission. A bare "Internal server
 * error" (what this used to be) sends the reader to the logs to find that out.
 */
describe('AppSecretsService.set when Key Vault refuses', () => {
  const PROJECT = '6aaa363961610d4d4107c5cf';

  /** A service wired to a stub vault client, so no network or credential is involved. */
  function serviceRejecting(error: unknown): AppSecretsService {
    const service = new AppSecretsService({
      keyVaultUri: 'https://vault.example/',
      azureClientId: '',
    } as AppConfigService);
    (service as unknown as { client: unknown }).client = {
      setSecret: jest.fn().mockRejectedValue(error),
    };
    return service;
  }

  it('says to sign in when the credential chain could not get a token', async () => {
    const service = serviceRejecting(
      Object.assign(new Error('ChainedTokenCredential authentication failed'), {
        name: 'AggregateAuthenticationError',
      }),
    );
    await expect(service.set(PROJECT, 'DATABASE_URL', 'x')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(service.set(PROJECT, 'DATABASE_URL', 'x')).rejects.toThrow(/az login/);
  });

  it('says to grant permission when the vault returns 403', async () => {
    const service = serviceRejecting(
      Object.assign(new Error('Forbidden'), { name: 'RestError', statusCode: 403 }),
    );
    await expect(service.set(PROJECT, 'JWT_SECRET', 'x')).rejects.toThrow(
      /Key Vault Secrets Officer/,
    );
  });

  it('names the credential that was not stored, whatever the failure', async () => {
    const service = serviceRejecting(new Error('socket hang up'));
    await expect(service.set(PROJECT, 'JWT_SECRET', 'x')).rejects.toThrow(/JWT_SECRET/);
  });

  /** The value must not travel back to the caller in an error message. */
  it('never repeats the value in the message', async () => {
    const service = serviceRejecting(new Error('Forbidden'));
    await expect(service.set(PROJECT, 'DATABASE_URL', 'super-secret-value')).rejects.not.toThrow(
      /super-secret-value/,
    );
  });
});

describe('ENV_NAME', () => {
  it.each(['DATABASE_URL', 'JWT_SECRET', 'A', 'PORT_2'])('accepts %s', (name) => {
    expect(ENV_NAME.test(name)).toBe(true);
  });

  /** Anything a shell or a Key Vault name would choke on has to be rejected before it is stored. */
  it.each(['database_url', '2FA_KEY', 'DB-PASSWORD', 'DB PASSWORD', 'DB.PASSWORD', ''])(
    'rejects %s',
    (name) => {
      expect(ENV_NAME.test(name)).toBe(false);
    },
  );
});

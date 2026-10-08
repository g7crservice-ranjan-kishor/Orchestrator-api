import { ServiceUnavailableException } from '@nestjs/common';
import { AdoClientService, adoErrorMessage, adoFailure } from './ado-client.service';
import { AppConfigService } from '../common/config/app-config.service';
import { SecretsService } from '../common/secrets/secrets.service';
import { AppSecretsService } from '../common/secrets/app-secrets.service';
import { ProjectsService } from '../projects/projects.service';

/**
 * Whose Azure DevOps the orchestrator speaks to.
 *
 * A project's own token is a high-privilege credential — it can create repositories and delete work
 * items — so the rules around it are worth pinning: a bound project uses its own, a project without
 * one falls back to the platform token (which is how every project worked before this existed), and
 * a vault that cannot be read must not take down a project that the platform token can still serve.
 */
describe('AdoClientService credentials', () => {
  const config = (orgUrl: string | null = 'https://dev.azure.com/platform') =>
    ({ adoOrgUrl: orgUrl }) as unknown as AppConfigService;

  const platform = (pat: string | null = 'platform-token') =>
    ({ get: jest.fn().mockResolvedValue(pat) }) as unknown as SecretsService;

  const vault = (impl: () => Promise<Record<string, string>>) =>
    ({ readAll: jest.fn().mockImplementation(impl) }) as unknown as AppSecretsService;

  const projects = (orgUrl: string | null = null) =>
    ({
      findById: jest.fn().mockResolvedValue(orgUrl ? { adoTarget: { orgUrl } } : null),
    }) as unknown as ProjectsService;

  /** The private helpers are what every public method funnels through. */
  const auth = (c: AdoClientService) =>
    (c as unknown as { authHeader(): Promise<string> }).authHeader();
  const org = (c: AdoClientService) => (c as unknown as { orgUrl(): Promise<string> }).orgUrl();

  const decode = (header: string) =>
    Buffer.from(header.replace('Basic ', ''), 'base64').toString().replace(/^:/, '');

  it("uses the bound project's own token", async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => ({ ADO_PAT: 'project-token' })),
      projects(),
    );
    expect(decode(await auth(client.for('p1')))).toBe('project-token');
  });

  /** Nothing already configured may stop working: no project token means the platform one. */
  it('falls back to the platform token when the project has none', async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => ({})),
      projects(),
    );
    expect(decode(await auth(client.for('p1')))).toBe('platform-token');
  });

  it('uses the platform token when no project is bound at all', async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => ({ ADO_PAT: 'project-token' })),
      projects(),
    );
    expect(decode(await auth(client))).toBe('platform-token');
  });

  /** A vault outage must not break a project the platform token can still serve. */
  it('falls back when the vault cannot be read', async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => {
        throw new Error('vault unreachable');
      }),
      projects(),
    );
    expect(decode(await auth(client.for('p1')))).toBe('platform-token');
  });

  it('refuses clearly when there is no token anywhere', async () => {
    const client = new AdoClientService(
      config(),
      platform(null),
      vault(async () => ({})),
      projects(),
    );
    await expect(auth(client.for('p1'))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("uses the bound project's own organization URL", async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => ({})),
      projects('https://dev.azure.com/theirs/'),
    );
    await expect(org(client.for('p1'))).resolves.toBe('https://dev.azure.com/theirs');
  });

  /** A project with no organization of its own uses the platform's, as it always did. */
  it('falls back to the platform organization URL', async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => ({})),
      projects(),
    );
    await expect(org(client.for('p1'))).resolves.toBe('https://dev.azure.com/platform');
  });

  /** Binding must not leak: the original client still speaks for the platform. */
  it('leaves the unbound client untouched', async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async () => ({ ADO_PAT: 'project-token' })),
      projects(),
    );
    client.for('p1');
    expect(decode(await auth(client))).toBe('platform-token');
  });

  it('keeps two bound clients independent', async () => {
    const client = new AdoClientService(
      config(),
      platform(),
      vault(async (...args: unknown[]) => {
        const projectId = (args as [string, string[]])[0];
        return { ADO_PAT: `${projectId}-token` };
      }),
      projects(),
    );
    expect(decode(await auth(client.for('alpha')))).toBe('alpha-token');
    expect(decode(await auth(client.for('beta')))).toBe('beta-token');
  });
});

/**
 * What a failed Azure DevOps call tells the person who has to fix it.
 *
 * A real push came back as `503 Service Unavailable — Azure DevOps request failed (400).` Two
 * things were wrong with that. The status said "Azure DevOps is down, try later" about a request
 * that would fail identically every time; and the message threw away the one sentence that says
 * what to do — Azure DevOps had answered with something like "TF401347: Invalid tree name", which
 * names the problem exactly.
 */
describe('Azure DevOps failures', () => {
  describe('the reason', () => {
    it("takes Azure DevOps' own message out of the body", () => {
      const body = JSON.stringify({ message: 'TF401347: Invalid tree name given for work item.' });
      expect(adoErrorMessage(body)).toBe('TF401347: Invalid tree name given for work item.');
    });

    it('falls back to the first line when the body is not JSON', () => {
      expect(adoErrorMessage(['Gateway timeout', 'some detail'].join('\n'))).toBe(
        'Gateway timeout',
      );
    });

    /** An HTML sign-in page says nothing a reader can use; markup is worse than silence. */
    it('says nothing rather than pasting markup', () => {
      expect(adoErrorMessage('<!DOCTYPE html><html>...')).toBeNull();
    });

    it('says nothing for an empty body', () => {
      expect(adoErrorMessage('')).toBeNull();
    });
  });

  describe('the status', () => {
    const body = JSON.stringify({ message: 'TF401347: Invalid tree name.' });

    /** The failure this was found by: our payload was wrong, so retrying changes nothing. */
    it('reports a rejected request as a bad request, not a service outage', () => {
      const error = adoFailure(400, body);
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('TF401347');
    });

    it('says the token may have expired on a 401', () => {
      expect(adoFailure(401, '').getStatus()).toBe(401);
      expect(adoFailure(401, '').message).toMatch(/expired/i);
    });

    /** A 403 is a scope problem, and the message has to name the scopes. */
    it('names the access a 403 is missing', () => {
      const error = adoFailure(403, '');
      expect(error.getStatus()).toBe(403);
      expect(error.message).toMatch(/Work Items/);
      expect(error.message).toMatch(/Code/);
    });

    it('reports a missing project or area path as not found', () => {
      expect(adoFailure(404, '').getStatus()).toBe(404);
    });

    /** A genuine outage keeps the status that means "try again later". */
    it('keeps a server error as unavailable', () => {
      expect(adoFailure(503, '').getStatus()).toBe(503);
    });

    it('still names the status when the body explains nothing', () => {
      expect(adoFailure(500, '').message).toContain('500');
    });
  });
});

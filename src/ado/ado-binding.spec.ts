import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every Azure DevOps call speaks with its own project's credentials.
 *
 * Each project now holds its own token, so `ado.for(projectId)` is what decides *whose* Azure
 * DevOps a call reaches. A call that skips it silently falls back to the platform token — which
 * still works in this installation and would therefore pass every other test, right up until
 * someone runs a project against their own organization and half the operations go to the wrong
 * place. Nothing about that failure points at the missing `.for(`, so the rule is pinned here
 * rather than left to review.
 */
describe('Azure DevOps calls are bound to a project', () => {
  const root = join(__dirname, '..');

  /**
   * Property access on the injected ADO client that binds to nothing.
   *
   * `for` binds to a project; `withCredentials` binds to credentials handed in directly, which is
   * how a project is set up before it has any of its own. Anything else reaches Azure DevOps on
   * whatever token happens to be configured platform-wide.
   */
  const UNBOUND = /this\.(?:ado|client)\.(?!for\b|withCredentials\b)[a-zA-Z]/;

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [path] : [];
    });

  it('has no call site that falls back to the platform token', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      // The secrets service holds a Key Vault client under the same name; it is not ADO.
      if (file.includes(join('common', 'secrets'))) continue;
      const source = readFileSync(file, 'utf8');
      if (!/AdoClientService/.test(source)) continue;
      source.split('\n').forEach((line, i) => {
        if (UNBOUND.test(line)) {
          offenders.push(`${file.slice(root.length + 1)}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

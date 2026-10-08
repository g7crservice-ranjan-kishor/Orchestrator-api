/** A process template an organization offers. */
export interface AdoProcess {
  id: string;
  name: string;
}

/**
 * The process the orchestrator requires.
 *
 * Every state name the orchestrator writes or reads is Scrum's: Tasks move `To Do` → `In Progress`
 * → `Done`, Stories are created in `Approved`, Bugs go `New` → `Committed` → `Done`. On an Agile
 * project those states do not exist — the work items are created and then never move, and the
 * board quietly finds nothing to do. Choosing the process at creation is what makes that
 * impossible rather than something to discover afterwards.
 */
export const REQUIRED_PROCESS = 'Scrum';

/**
 * Picks the process to create a project with.
 *
 * Prefers the organization's own Scrum template, which may be an inherited copy with a different
 * name — an organization that has customised Scrum usually keeps "Scrum" in the name, so an exact
 * match wins and a name containing it is the fallback. Returns null when the organization has
 * nothing Scrum-like, which is a refusal worth making loudly: creating the project on whatever is
 * available would produce one the orchestrator cannot drive.
 */
export function pickProcess(processes: AdoProcess[]): AdoProcess | null {
  const usable = (processes ?? []).filter((p) => p?.id && p?.name);
  const exact = usable.find((p) => p.name.trim().toLowerCase() === REQUIRED_PROCESS.toLowerCase());
  if (exact) return exact;
  return usable.find((p) => p.name.toLowerCase().includes(REQUIRED_PROCESS.toLowerCase())) ?? null;
}

/** Names the processes an organization has, for a message someone can act on. */
export function describeProcesses(processes: AdoProcess[]): string {
  const names = (processes ?? []).map((p) => p?.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'none';
}

/**
 * Azure DevOps project names are stricter than product names.
 *
 * They cannot contain `/ \ : * ? " < > | ; # $ * { } , + = [ ]`, cannot start with an underscore,
 * cannot start or end with a full stop, and cannot be a reserved Windows name. A product called
 * "Employee Management System" is fine; one called "C# / .NET tooling" is not, and failing at the
 * create call with Azure DevOps' own wording helps nobody.
 */
export function toProjectName(productName: string): string {
  const cleaned = (productName ?? '')
    .replace(/[/\\:*?"<>|;#$%{},+=[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[._\s]+|[.\s]+$/g, '')
    .slice(0, 64)
    .trim();
  return cleaned;
}

/**
 * A description Azure DevOps will accept.
 *
 * Azure DevOps refuses control characters outright — a tab pasted in with the text came back as
 * "TF20507: The string argument contains a character that is not valid:'u0009'", which names a
 * character nobody can see and a parameter nobody typed. Text is pasted from documents and chat
 * windows all the time, so the orchestrator cleans it rather than making a person hunt for an
 * invisible character. The limit is Azure DevOps' own.
 */
export const MAX_PROJECT_DESCRIPTION = 256;

export function toProjectDescription(description: string): string {
  return (
    (description ?? '')
      // Every control character, tabs and newlines included, becomes an ordinary space.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROJECT_DESCRIPTION)
  );
}

/**
 * Tidies a name the person typed, without changing what they meant.
 *
 * Only what they cannot see: control characters pasted in with the text, runs of whitespace, and
 * surrounding space. The characters Azure DevOps forbids outright are left alone deliberately, so
 * {@link projectNameProblem} can ask about them — quietly turning "a/b" into "a b" would create a
 * project under a name nobody chose, and they would find out by reading it in Azure DevOps.
 */
export function tidyProjectName(name: string): string {
  return (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why a name cannot be used, or null when it can. */
export function projectNameProblem(name: string): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'Give the Azure DevOps project a name.';
  if (trimmed.length > 64) return 'An Azure DevOps project name may be at most 64 characters.';
  if (/[/\\:*?"<>|;#$%{},+=[\]]/.test(trimmed)) {
    return 'An Azure DevOps project name cannot contain / \\ : * ? " < > | ; # $ % { } , + = [ ]';
  }
  if (trimmed.startsWith('_'))
    return 'An Azure DevOps project name cannot start with an underscore.';
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    return 'An Azure DevOps project name cannot start or end with a full stop.';
  }
  return null;
}

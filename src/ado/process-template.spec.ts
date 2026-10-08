import {
  describeProcesses,
  MAX_PROJECT_DESCRIPTION,
  tidyProjectName,
  toProjectDescription,
  pickProcess,
  projectNameProblem,
  REQUIRED_PROCESS,
  toProjectName,
} from './process-template';

/**
 * Choosing the process a new Azure DevOps project is created with.
 *
 * Every state the orchestrator writes or reads is Scrum's — Tasks move `To Do` → `In Progress` →
 * `Done`, Stories are created in `Approved`. On an Agile project none of those states exist: the
 * work items are created and then never move, and the board simply finds nothing to do. A push
 * against such a project failed with "the value 'Approved' is not in the list of supported
 * values", which is the loud version of the same problem.
 */
const p = (id: string, name: string) => ({ id, name });

describe('process selection', () => {
  it('requires Scrum', () => {
    expect(REQUIRED_PROCESS).toBe('Scrum');
  });

  it('picks the organization Scrum template', () => {
    const chosen = pickProcess([p('1', 'Agile'), p('2', 'Scrum'), p('3', 'CMMI')]);
    expect(chosen?.id).toBe('2');
  });

  it('ignores casing', () => {
    expect(pickProcess([p('1', 'scrum')])?.id).toBe('1');
  });

  /** An organization that customised Scrum usually keeps the word in the name. */
  it('falls back to an inherited template whose name contains Scrum', () => {
    const chosen = pickProcess([p('1', 'Agile'), p('2', 'Acme Scrum v2')]);
    expect(chosen?.id).toBe('2');
  });

  it('prefers an exact match over a inherited one', () => {
    const chosen = pickProcess([p('1', 'Acme Scrum v2'), p('2', 'Scrum')]);
    expect(chosen?.id).toBe('2');
  });

  /** Creating on whatever is available would produce a project nothing can drive. */
  it('refuses rather than settling for another process', () => {
    expect(pickProcess([p('1', 'Agile'), p('2', 'CMMI')])).toBeNull();
    expect(pickProcess([])).toBeNull();
  });

  it('names what the organization does have, so the message can say', () => {
    expect(describeProcesses([p('1', 'Agile'), p('2', 'CMMI')])).toBe('Agile, CMMI');
    expect(describeProcesses([])).toBe('none');
  });
});

/**
 * Azure DevOps project names are stricter than product names, and failing at the create call with
 * Azure DevOps' own wording helps nobody.
 */
describe('project names', () => {
  it('passes an ordinary product name through', () => {
    expect(toProjectName('Employee Management System')).toBe('Employee Management System');
  });

  /** A full stop is only a problem at the ends, so `.NET` in the middle survives. */
  it('removes the characters Azure DevOps rejects and keeps the rest', () => {
    expect(toProjectName('C# / .NET tooling')).toBe('C .NET tooling');
    expect(projectNameProblem(toProjectName('C# / .NET tooling'))).toBeNull();
  });

  it('collapses the spaces left behind', () => {
    expect(toProjectName('A  ///  B')).toBe('A B');
  });

  it('trims leading underscores and surrounding stops', () => {
    expect(toProjectName('_hidden.')).toBe('hidden');
  });

  describe('rejecting a name', () => {
    it('accepts a usable one', () => {
      expect(projectNameProblem('Employee Management System')).toBeNull();
    });

    it('refuses an empty name', () => {
      expect(projectNameProblem('   ')).toMatch(/give the azure devops project a name/i);
    });

    it('names the characters that are not allowed', () => {
      expect(projectNameProblem('a/b')).toMatch(/cannot contain/i);
    });

    it('refuses a leading underscore and a trailing stop', () => {
      expect(projectNameProblem('_x')).toMatch(/underscore/i);
      expect(projectNameProblem('x.')).toMatch(/full stop/i);
    });

    it('refuses one that is too long', () => {
      expect(projectNameProblem('x'.repeat(65))).toMatch(/64 characters/i);
    });
  });
});

/**
 * Cleaning a description Azure DevOps will take.
 *
 * It refuses control characters outright. A tab pasted in with the text came back as "TF20507: The
 * string argument contains a character that is not valid:'u0009'" — a character nobody can see,
 * named in a parameter nobody typed. Text is pasted from documents and chat windows constantly, so
 * it is cleaned rather than left for someone to hunt through.
 */
describe('project descriptions', () => {
  const TAB = String.fromCharCode(9);
  const NEWLINE = String.fromCharCode(10);

  it('passes ordinary text through', () => {
    expect(toProjectDescription('Employee records with login')).toBe('Employee records with login');
  });

  /** The failure itself. */
  it('replaces a tab rather than letting Azure DevOps refuse it', () => {
    const cleaned = toProjectDescription('Employee' + TAB + 'records');
    expect(cleaned).toBe('Employee records');
    expect(cleaned).not.toContain(TAB);
  });

  it('flattens newlines too', () => {
    expect(toProjectDescription('Line one' + NEWLINE + 'line two')).toBe('Line one line two');
  });

  it('collapses the runs of whitespace that leaves behind', () => {
    expect(toProjectDescription('a' + TAB + TAB + '  b')).toBe('a b');
  });

  it('leaves no control character of any kind', () => {
    const messy = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(31) + 'c';
    const anyControl = new RegExp('[\\u0000-\\u001f\\u007f]');
    expect(anyControl.test(toProjectDescription(messy))).toBe(false);
  });

  it('trims and caps at the length Azure DevOps allows', () => {
    expect(toProjectDescription('  padded  ')).toBe('padded');
    expect(toProjectDescription('x'.repeat(400)).length).toBe(MAX_PROJECT_DESCRIPTION);
  });

  it('copes with nothing at all', () => {
    expect(toProjectDescription('')).toBe('');
  });
});

/**
 * Tidying a name someone typed.
 *
 * Invisible characters are cleaned, because a tab pasted in with the text is not a decision anyone
 * made. The characters Azure DevOps forbids outright are left alone on purpose: turning "a/b" into
 * "a b" would create a project under a name nobody chose, and they would find out by reading it in
 * Azure DevOps afterwards.
 */
describe('tidying a project name', () => {
  const TAB = String.fromCharCode(9);

  it('leaves an ordinary name alone', () => {
    expect(tidyProjectName('Employee Management System')).toBe('Employee Management System');
  });

  it('removes characters that were never visible', () => {
    expect(tidyProjectName('Employee' + TAB + 'System')).toBe('Employee System');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(tidyProjectName('  Employee   System  ')).toBe('Employee System');
  });

  /** The decision stays with the person: this is a question, not something to paper over. */
  it('leaves forbidden characters for the check to refuse', () => {
    expect(tidyProjectName('a/b')).toBe('a/b');
    expect(projectNameProblem(tidyProjectName('a/b'))).toMatch(/cannot contain/i);
  });
});

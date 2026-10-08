import { splitByScope } from './requirement-scope';
import {
  detectDatabaseName,
  detectFromRequirement,
  OUT_OF_SCOPE,
  resolveTechnicalDetails,
  unansweredQuestions,
} from './technical-details';

/**
 * Reading what a requirement rules *out*.
 *
 * Taken from the AI Quiz Generator's real requirement, which is where this was found. Read as
 * flat text it appears to ask for email and notifications and to say nothing about databases or
 * signing in — the exact opposite of what it says. The stack reader reported two integrations
 * nobody wanted, and would have blocked approval on two questions the document had already
 * answered in the clearest words available to it.
 */

/** The shape of the real requirement, trimmed to what matters. */
const QUIZ = `# AI Quiz Generator (POC)

Build a quiz generator with React, TypeScript and Tailwind, served by a FastAPI backend.
Generate a well-formatted PDF and allow the user to download it.

---

# POC Scope

This is a Proof of Concept.

The following features are **out of scope**:

- Authentication
- Authorization
- User Management
- Database integration
- Refresh Tokens
- Email Notifications
- CI/CD Pipelines
- Kubernetes

Keep the implementation simple while remaining production-quality.`;

describe('splitting a requirement by scope', () => {
  it('puts an excluded list on the excluded side', () => {
    const { excluded } = splitByScope(QUIZ);
    expect(excluded).toContain('Email Notifications');
    expect(excluded).toContain('Database integration');
  });

  it('keeps what the requirement actually asks for', () => {
    const { inScope } = splitByScope(QUIZ);
    expect(inScope).toContain('FastAPI');
    expect(inScope).toContain('Tailwind');
  });

  /**
   * The conservative half, and the more important one. A sentence-introduced exclusion owns the
   * list that follows it and nothing more — swallowing real requirements would silently drop
   * work, which is far worse than asking one question too many.
   */
  it('gives the document back when ordinary prose resumes', () => {
    const { inScope, excluded } = splitByScope(QUIZ);
    expect(inScope).toContain('Keep the implementation simple');
    expect(excluded).not.toContain('Keep the implementation simple');
  });

  it('lets a heading own its whole section', () => {
    const { inScope, excluded } = splitByScope(
      '## Out of scope\n\nNo payments in this release.\n\n## Scope\n\nBuild it with React.',
    );
    expect(excluded).toContain('No payments');
    expect(inScope).toContain('React');
  });

  it('has nothing excluded when nothing is ruled out', () => {
    expect(splitByScope('Build an employee directory with React.').excluded).toBe('');
  });

  it('copes with an empty requirement', () => {
    expect(splitByScope('')).toEqual({ inScope: '', excluded: '' });
  });
});

describe('the stack read from a requirement that rules things out', () => {
  const details = () => Object.fromEntries(resolveTechnicalDetails(QUIZ).map((d) => [d.field, d]));

  it('still reads everything the requirement does ask for', () => {
    expect(detectFromRequirement(QUIZ)).toMatchObject({
      frontend: 'React',
      language: 'TypeScript',
      uiFramework: 'Tailwind',
      backend: 'FastAPI',
    });
  });

  /** The false positive that started this: an excluded feature is not a feature. */
  it('does not report an excluded feature as an integration', () => {
    expect(details().integrations.value).not.toContain('Email');
    expect(details().integrations.value).not.toContain('Notifications');
  });

  it('records a ruled-out decision as answered, not missing', () => {
    expect(details().database).toMatchObject({ value: OUT_OF_SCOPE, source: 'requirement' });
    expect(details().auth).toMatchObject({ value: OUT_OF_SCOPE, source: 'requirement' });
  });

  /**
   * The point of all of it. Before this, approving the Quiz Generator meant answering "which
   * database?" and "how should people sign in?" about a proof of concept whose requirement says,
   * in a section of its own, that it has neither.
   */
  it('asks nothing a requirement this explicit has already answered', () => {
    expect(unansweredQuestions(resolveTechnicalDetails(QUIZ))).toEqual([]);
  });

  /** An exclusion must not be able to override something the requirement asks for elsewhere. */
  it('lets a real choice outrank a word in the excluded list', () => {
    const text =
      'Store everything in PostgreSQL.\n\n## Out of scope\n\n- Database migrations tooling';
    const database = resolveTechnicalDetails(text).find((d) => d.field === 'database');
    expect(database).toMatchObject({ value: 'PostgreSQL', source: 'requirement' });
  });
});

describe('the patterns that used to over-match', () => {
  const value = (text: string, field: string) =>
    resolveTechnicalDetails(text).find((d) => d.field === field)?.value;

  /** An email *field* is not a mail integration. */
  it('does not read an integration out of the word email', () => {
    expect(value('Employees have a name and an email address.', 'integrations')).toBeNull();
    expect(
      value('The app sends email when a leave request is approved.', 'integrations'),
    ).toContain('Email');
  });

  /** Naming a login screen is not choosing how people sign in. */
  it('does not read an authentication method out of a screen name', () => {
    const text =
      'Every existing screen must support both themes:\n- Login screen\n- Employees list';
    expect(value(text, 'auth')).toBeNull();
    expect(value('Users sign in with a username and password.', 'auth')).toBe(
      'Username and password',
    );
  });

  it('does not read a notification service out of the word notification', () => {
    expect(value('Show a notification when the save succeeds.', 'integrations')).toBeNull();
    expect(value('Send push notifications to the mobile app.', 'integrations')).toContain(
      'Notifications',
    );
  });
});

/**
 * An exclusion is about the *change*, not about the product.
 *
 * The dark-mode requirement for the Employee Management System rules backend and database work
 * out of scope — of that change. The product still runs on SQL Server. Reporting "Database: out
 * of scope" for a product with a live database would be a worse lie than the question it saves.
 */
describe('an exclusion against a product that already exists', () => {
  const DARK_MODE =
    'Add a dark mode to the application.\n\n' +
    '## Out of scope\n\n- Backend changes\n- Database changes\n';

  it('does not let an exclusion unmake the project’s real configuration', () => {
    const database = resolveTechnicalDetails(DARK_MODE, { database: 'SQL Server' }).find(
      (d) => d.field === 'database',
    );
    expect(database).toMatchObject({ value: 'SQL Server', source: 'project' });
  });

  it('does not let an exclusion unmake what the product was built with', () => {
    const backend = resolveTechnicalDetails(DARK_MODE, {}, { backend: 'Node.js' }).find(
      (d) => d.field === 'backend',
    );
    expect(backend).toMatchObject({ value: 'Node.js', source: 'project' });
  });

  /** With nothing known, the exclusion is still the best answer available — better than asking. */
  it('falls back to the exclusion when nothing else knows', () => {
    const backend = resolveTechnicalDetails(DARK_MODE).find((d) => d.field === 'backend');
    expect(backend).toMatchObject({ value: OUT_OF_SCOPE, source: 'requirement' });
  });
});

/**
 * A change request describes the change, not the stack. Read as a fresh requirement it reports
 * gaps whose answers are sitting in the repository the change is being made to.
 */
describe('inheriting the stack into a change request', () => {
  const BUILT_WITH = { frontend: 'React', language: 'TypeScript', backend: 'Node.js' };

  it('carries forward what the product was built with', () => {
    const details = Object.fromEntries(
      resolveTechnicalDetails('Add a dark mode.', {}, BUILT_WITH).map((d) => [d.field, d]),
    );
    expect(details.frontend).toMatchObject({ value: 'React', source: 'project' });
    expect(details.backend).toMatchObject({ value: 'Node.js', source: 'project' });
  });

  it('asks nothing it already knows from the earlier plan', () => {
    const asked = unansweredQuestions(
      resolveTechnicalDetails('Add a dark mode.', { database: 'SQL Server' }, BUILT_WITH),
    ).map((d) => d.field);
    expect(asked).not.toContain('frontend');
    expect(asked).not.toContain('backend');
    expect(asked).not.toContain('database');
  });

  /** A change that genuinely replaces part of the stack must still be able to say so. */
  it('lets the change request override what was inherited', () => {
    const frontend = resolveTechnicalDetails(
      'Rewrite the interface in Angular.',
      {},
      BUILT_WITH,
    ).find((d) => d.field === 'frontend');
    expect(frontend).toMatchObject({ value: 'Angular', source: 'requirement' });
  });
});

/**
 * Found by running the reader over the Expense Tracker requirement before building it, rather
 * than by predicting what it would say. Both of these looked right until a real document was
 * put through them.
 */
describe('a technical section that states types rather than names', () => {
  const EXPENSE = `Build a Personal Expense Tracker.

Each expense contains: Title, Amount, Category, Date, Payment Method, Notes.
Payment Methods: Cash, Card, UPI

7. Technical Requirements
Frontend: React, TypeScript, Ant Design
Backend: Node.js, Express.js
Database: SQL
Authentication: JWT`;

  const byField = () =>
    Object.fromEntries(resolveTechnicalDetails(EXPENSE).map((d) => [d.field, d]));

  it('reads the stack the requirement states', () => {
    const f = byField();
    expect(f.frontend.value).toBe('React');
    expect(f.uiFramework.value).toBe('Ant Design');
    expect(f.backend.value).toBe('Express');
    expect(f.auth.value).toBe('JWT');
  });

  /** "Database: SQL" states a kind, not a name — this would have named the database "SQL". */
  it('does not take a database type for a database name', () => {
    expect(detectDatabaseName('Database: SQL')).toBeNull();
    expect(detectDatabaseName('Database: PostgreSQL')).toBeNull();
    expect(byField().databaseName.value).toBeNull();
  });

  /** It still reads a real name, which is the whole point of the field. */
  it('still reads a name when one is given', () => {
    expect(detectDatabaseName('Database: ExpenseTrackerDb')).toBe('ExpenseTrackerDb');
  });

  /** An expense's *payment method* is a column it stores, not a provider it talks to. */
  it('does not read a payment integration out of a payment method field', () => {
    expect(byField().integrations.value).toBeNull();
    expect(
      resolveTechnicalDetails('Take payments with Stripe at checkout.').find(
        (d) => d.field === 'integrations',
      )?.value,
    ).toContain('Payments');
  });

  /** "SQL" names no product, so which database to use is a real question. */
  it('asks which database, because SQL is not one', () => {
    expect(unansweredQuestions(resolveTechnicalDetails(EXPENSE)).map((d) => d.field)).toEqual([
      'database',
    ]);
  });
});

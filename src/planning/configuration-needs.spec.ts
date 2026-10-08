import { configurationNeeds, isServerless, repoNameFor } from './configuration-needs';

/**
 * What the plan says the project still needs.
 *
 * Asking for a database and repositories on the way in means asking before anyone knows whether
 * the product needs them — which is how a project ends up configured for a database it never uses,
 * and with repositories whose names have nothing to do with what was planned. The plan is the first
 * point at which the answer exists, so it is the first point worth asking.
 */
describe('configuration needs', () => {
  const plan = (body: string) => configurationNeeds(body, 'Expense Tracker');

  describe('database', () => {
    it('asks for a database when the plan stores data', () => {
      const needs = plan('## Architecture\n- Expenses are persisted in a relational database.');
      expect(needs.needsDatabase).toBe(true);
    });

    /** The person answering has to be able to see why they are being asked. */
    it('quotes the line that prompted the question', () => {
      const needs = plan('## Architecture\n- Expenses are persisted in a relational database.');
      expect(needs.databaseEvidence).toBe('Expenses are persisted in a relational database.');
    });

    it('recognises persistence from migrations and schemas alone', () => {
      expect(plan('- A migration creates the expense table.').needsDatabase).toBe(true);
    });

    it('recognises it from CRUD', () => {
      expect(plan('- CRUD for categories.').needsDatabase).toBe(true);
    });

    /** A product that stores nothing must not be asked to pick a database it will never use. */
    it('does not ask when nothing is stored', () => {
      const needs = plan('## Overview\n- A calculator that converts currency in the browser.');
      expect(needs.needsDatabase).toBe(false);
      expect(needs.databaseEvidence).toBeNull();
    });

    it('ignores headings when quoting the reason', () => {
      const needs = plan('## Database\n- Expenses are stored in Postgres.');
      expect(needs.databaseEvidence).toBe('Expenses are stored in Postgres.');
    });
  });

  describe('repositories', () => {
    it('takes the names the plan states outright', () => {
      const needs = plan(
        '## Repositories\n- repo: expense-api — the server\n- repo: expense-ui — the interface',
      );
      expect(needs.repositories).toEqual(['expense-api', 'expense-ui']);
    });

    /** 'Repository pattern' in an architecture paragraph is not a repository name. */
    it('is not fooled by the repository pattern', () => {
      const needs = plan('## Architecture\n- Data access uses the repository pattern.');
      expect(needs.repositories).not.toContain('pattern');
    });

    it('suggests one repository per half when the plan names none', () => {
      const needs = plan('- A REST API serves the data.\n- A React frontend shows the screens.');
      expect(needs.repositories).toEqual(['expense-tracker-api', 'expense-tracker-ui']);
    });

    it('suggests only an interface for a product with no server', () => {
      const needs = plan('- A single page with components that render in the browser.');
      expect(needs.repositories).toEqual(['expense-tracker-ui']);
    });

    it('suggests nothing for a plan that describes neither', () => {
      expect(plan('## Overview\n- Work out what to build.').repositories).toEqual([]);
    });

    it('does not repeat a name the plan states twice', () => {
      const needs = plan('## Repositories\n- repo: expense-api\n- repo: expense-api');
      expect(needs.repositories).toEqual(['expense-api']);
    });
  });

  describe('suggested names', () => {
    it('turns a product name into a name Azure DevOps accepts', () => {
      expect(repoNameFor('Expense Tracker!', 'api')).toBe('expense-tracker-api');
    });

    it('falls back to something usable when the name is all punctuation', () => {
      expect(repoNameFor('***', 'ui')).toBe('product-ui');
    });
  });
  describe('interface framework', () => {
    /** A requirement asking for Material UI has to produce a product built with it. */
    it('takes the framework the plan names', () => {
      expect(plan('- The interface is built with Material UI.').uiStyle).toBe('mui');
    });

    it('recognises the short form', () => {
      expect(plan('- Screens use MUI components.').uiStyle).toBe('mui');
    });

    it('recognises Tailwind and Ant Design', () => {
      expect(plan('- Styled with Tailwind.').uiStyle).toBe('tailwind');
      expect(plan('- Built on Ant Design.').uiStyle).toBe('antd');
    });

    /** Nothing named means nothing to impose — the project's own choice stands. */
    it('names none when the plan names none', () => {
      expect(plan('- A page that lists expenses.').uiStyle).toBeNull();
    });

    /** 'mui' inside another word is not a framework. */
    it('is not fooled by a fragment of another word', () => {
      expect(plan('- Communication is by email.').uiStyle).toBeNull();
    });
  });
});

/**
 * A browser-only product, in the words a real plan used.
 *
 * These lines are taken from the first plan this ran against for real. It was read as needing a
 * database and an API repository — from the words "persist", "database" and "API" appearing in the
 * very sentences that ruled them out. The nouns are present in a denial; the denial has to be read
 * first.
 */
describe('a plan that states there is no server side', () => {
  const FOCUS_TIMER = [
    '# Plan',
    '',
    '## Objective',
    'Deliver a browser-only Pomodoro-style focus timer: a person runs repeating work/break',
    "cycles, and can see today's progress persist across a page refresh — all without a server,",
    'a database, or an account.',
    '',
    '## Scope',
    '- A single client-side application (no backend, no API, no database — everything lives in',
    "  the browser's own storage, per the requirement).",
  ].join('\n');

  const needs = () => configurationNeeds(FOCUS_TIMER, 'Focus Timer');

  it('does not ask for a database', () => {
    expect(needs().needsDatabase).toBe(false);
  });

  /** Distinct from "nothing found": the plan decided this, and the panel says so. */
  it('reports it as a stated decision', () => {
    expect(needs().serverless).toBe(true);
  });

  /** "persist across a page refresh" is real persistence — in the browser, not a database. */
  it('is not fooled by data that persists in the browser', () => {
    expect(needs().databaseEvidence).toBeNull();
  });

  it('suggests only an interface repository', () => {
    expect(needs().repositories).toEqual(['focus-timer-ui']);
  });

  /** The guard has to be narrow, or an ordinary full-stack plan trips it. */
  it('is not triggered by ordinary sentences that happen to contain a "no"', () => {
    expect(isServerless('- The API has no API versioning yet.')).toBe(false);
    expect(isServerless('- A visitor can browse without an account.')).toBe(false);
    expect(isServerless('- The browser never reaches the database directly.')).toBe(false);
  });

  it('still asks a product that really does store data on a server', () => {
    const full = configurationNeeds(
      [
        '## Architecture',
        '- Expenses are persisted in a relational database.',
        '- A REST API serves them.',
      ].join('\n'),
      'Expense Tracker',
    );
    expect(full.needsDatabase).toBe(true);
    expect(full.serverless).toBe(false);
    expect(full.repositories).toContain('expense-tracker-api');
  });
});

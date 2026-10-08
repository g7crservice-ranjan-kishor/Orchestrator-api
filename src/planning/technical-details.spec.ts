import {
  detectDatabaseName,
  detectFromRequirement,
  isComplete,
  resolveTechnicalDetails,
  unansweredQuestions,
  isDatabaseType,
  TECHNICAL_FIELDS,
  TECHNICAL_FIELD_OPTIONS,
} from './technical-details';

/**
 * What a requirement already says must never be asked about again.
 *
 * Two failures sit either side of this. Planning a product whose stack nobody chose means the
 * agent chooses — the Employee Management System's plan named PostgreSQL while the project was
 * pinned to SQL Server, an assumption made in silence that surfaced when a connection string
 * refused to parse. And asking someone for a thing their own requirement states, in its own words,
 * is how a tool teaches people to click past its questions.
 *
 * Detection is literal on purpose. A technology counts as chosen only when it is named: guessing
 * "React" from "modern" would be worse than asking, because a wrong answer labelled *detected* is
 * one nobody re-reads.
 */

/** The example from the specification, word for word. */
const FULL =
  'Build the application using React, TypeScript, Ant Design, Node.js and MongoDB with the ' +
  'database named EmployeeDB.';

describe('reading a requirement that says everything', () => {
  it('finds each technology the requirement names', () => {
    expect(detectFromRequirement(FULL)).toMatchObject({
      frontend: 'React',
      language: 'TypeScript',
      uiFramework: 'Ant Design',
      backend: 'Node.js',
      database: 'MongoDB',
      databaseName: 'EmployeeDB',
    });
  });

  it('marks every one of them as coming from the requirement', () => {
    const details = resolveTechnicalDetails(FULL);
    const sources = Object.fromEntries(details.map((d) => [d.field, d.source]));
    expect(sources).toMatchObject({
      frontend: 'requirement',
      language: 'requirement',
      uiFramework: 'requirement',
      backend: 'requirement',
      database: 'requirement',
      databaseName: 'requirement',
    });
  });
});

describe('recognising how people actually write things', () => {
  const detects = (text: string) => detectFromRequirement(text);

  it('reads the common spellings', () => {
    expect(detects('a Next.js app').frontend).toBe('Next.js');
    expect(detects('written in Type Script').language).toBe('TypeScript');
    expect(detects('styled with antd').uiFramework).toBe('Ant Design');
    expect(detects('use Tailwind CSS').uiFramework).toBe('Tailwind');
    expect(detects('an ASP.NET backend').backend).toBe('ASP.NET');
    expect(detects('store it in Postgres').database).toBe('PostgreSQL');
    expect(detects('Azure SQL for persistence').database).toBe('SQL Server');
  });

  /** "JavaScript" contains "Java"; reporting Java for a JavaScript product would be a silent lie. */
  it('does not read Java out of JavaScript', () => {
    expect(detects('written in JavaScript').language).toBe('JavaScript');
    expect(detects('a Java Spring Boot service').language).toBe('Java');
  });

  it('prefers the more specific framework when both appear', () => {
    expect(detects('a Next.js app built on React').frontend).toBe('Next.js');
    expect(detects('a NestJS service running on Node.js').backend).toBe('NestJS');
  });

  it('finds every integration, not just the first', () => {
    const value = detects('it sends email and takes payments by Stripe').integrations;
    expect(value).toContain('Email');
    expect(value).toContain('Payments');
  });
});

describe('a database name, which is written rather than chosen', () => {
  it('reads the phrasings that genuinely name one', () => {
    expect(detectDatabaseName('the database named EmployeeDB')).toBe('EmployeeDB');
    expect(detectDatabaseName('a database called student_records')).toBe('student_records');
    expect(detectDatabaseName('database: InventoryDb')).toBe('InventoryDb');
  });

  /** A capitalised word near "database" is not a name, and guessing would misplace real data. */
  it('does not invent one from nearby words', () => {
    expect(detectDatabaseName('store employees in the database')).toBeNull();
    expect(detectDatabaseName('a MongoDB database for the app')).toBeNull();
    expect(detectDatabaseName('')).toBeNull();
  });
});

describe('falling back to what the project already decided', () => {
  const REQUIREMENT = 'Build an employee directory with a login screen.';

  it('uses the project’s configuration when the requirement is silent', () => {
    const details = resolveTechnicalDetails(REQUIREMENT, {
      database: 'SQL Server',
      uiFramework: 'Ant Design',
    });
    const byField = Object.fromEntries(details.map((d) => [d.field, d]));
    expect(byField.database).toMatchObject({ value: 'SQL Server', source: 'project' });
    expect(byField.uiFramework).toMatchObject({ value: 'Ant Design', source: 'project' });
  });

  /** The core principle: the requirement outranks the project's own default. */
  it('lets the requirement override the project', () => {
    const details = resolveTechnicalDetails('Use MongoDB for storage.', { database: 'SQL Server' });
    const database = details.find((d) => d.field === 'database');
    expect(database).toMatchObject({ value: 'MongoDB', source: 'requirement' });
  });
});

describe('what is left to ask', () => {
  /**
   * The specification's own example names six technologies and says nothing about signing in —
   * so exactly one question survives. That is the feature: not "ask nothing", but "ask only what
   * is genuinely unanswered".
   */
  it('asks only about what the requirement left out', () => {
    const asked = unansweredQuestions(resolveTechnicalDetails(FULL)).map((d) => d.field);
    expect(asked).toEqual(['auth']);
  });

  it('asks nothing once the last gap is filled', () => {
    const complete = `${FULL} Sign in with a seeded administrator using JWT.`;
    expect(unansweredQuestions(resolveTechnicalDetails(complete))).toEqual([]);
    expect(isComplete(resolveTechnicalDetails(complete))).toBe(true);
  });

  it('asks only for what is required and still unknown', () => {
    const details = resolveTechnicalDetails('Build an employee directory.');
    const asked = unansweredQuestions(details).map((d) => d.field);
    expect(asked).toContain('frontend');
    expect(asked).toContain('backend');
    expect(asked).toContain('database');
    expect(asked).toContain('auth');
  });

  /**
   * Optional details that are missing are left alone. A product that mentions no integrations
   * probably has none, and asking anyway is the noise that makes people stop reading questions.
   */
  it('does not ask about optional details nobody mentioned', () => {
    const details = resolveTechnicalDetails('Build an employee directory.');
    const asked = unansweredQuestions(details).map((d) => d.field);
    expect(asked).not.toContain('integrations');
    expect(asked).not.toContain('uiFramework');
    expect(asked).not.toContain('databaseName');
  });

  it('every question it asks is a real sentence', () => {
    for (const detail of unansweredQuestions(resolveTechnicalDetails('Build something.'))) {
      expect(detail.question.length).toBeGreaterThan(20);
      expect(detail.question).toContain('?');
    }
  });

  /** "No sign-in" and "no database" are answers, not silence. */
  it('treats an explicit absence as an answer', () => {
    const details = resolveTechnicalDetails(
      'A browser-only timer with no sign-in. React and TypeScript, no backend, nothing stored on a server.',
    );
    const byField = Object.fromEntries(details.map((d) => [d.field, d]));
    expect(byField.auth).toMatchObject({ value: 'No sign-in', source: 'requirement' });
  });
});

/**
 * The screen offers the usual answers rather than making someone type them.
 *
 * Drawn from the same vocabulary that detects a technology in a requirement, so what a person can
 * pick and what the detector recognises cannot drift apart.
 */
describe('TECHNICAL_FIELD_OPTIONS', () => {
  it('offers the vocabulary each field is detected by', () => {
    expect(TECHNICAL_FIELD_OPTIONS.frontend).toEqual(
      expect.arrayContaining(['React', 'Angular', 'Vue']),
    );
    expect(TECHNICAL_FIELD_OPTIONS.database).toEqual(
      expect.arrayContaining(['SQL Server', 'PostgreSQL', 'MongoDB']),
    );
    expect(TECHNICAL_FIELD_OPTIONS.auth).toEqual(expect.arrayContaining(['Entra ID', 'OAuth']));
  });

  it('covers every field', () => {
    for (const field of TECHNICAL_FIELDS) {
      expect(TECHNICAL_FIELD_OPTIONS[field]).toBeDefined();
    }
  });

  /** A name is not chosen from a menu. */
  it('offers nothing for the database name', () => {
    expect(TECHNICAL_FIELD_OPTIONS.databaseName).toEqual([]);
  });

  /**
   * Every option is a value the detector would recognise if a requirement named it instead. This
   * is the property that keeps the two lists honest as either one grows.
   */
  it('offers only values the detector reads back', () => {
    const detected = detectFromRequirement(
      `This is built with ${TECHNICAL_FIELD_OPTIONS.frontend[0]}.`,
    );
    expect(detected.frontend).toBe(TECHNICAL_FIELD_OPTIONS.frontend[0]);
  });
});

/**
 * "SQL" went into the database *name* on the first real run, because two adjacent rows asking
 * about the database read as one question asked twice. The question now says which is which, and
 * the predicate that already refuses a database type when reading a requirement refuses it here.
 */
describe('a database type is not a database name', () => {
  it('rejects the kinds of database as names', () => {
    for (const value of ['SQL', 'sql', 'NoSQL', 'database', 'DB', 'SQL Server', 'PostgreSQL']) {
      expect(isDatabaseType(value)).toBe(true);
    }
  });

  it('accepts an actual name', () => {
    for (const value of ['appointment_booking', 'employee-management', 'ticketdb']) {
      expect(isDatabaseType(value)).toBe(false);
    }
  });

  it('asks for the name in a way that cannot be read as the kind', () => {
    const question = resolveTechnicalDetails('A product.', {}).find(
      (d) => d.field === 'databaseName',
    )?.question;
    expect(question).toContain('not the kind of database');
  });
});

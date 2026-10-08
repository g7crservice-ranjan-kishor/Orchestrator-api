/**
 * The database a project's generated application is built against.
 *
 * Left to itself the planning agent picks a database from the requirement prose, which is how a
 * plan ends up specifying PostgreSQL for a team that has an Azure SQL server ready to use — and
 * the mismatch only surfaces when the supplied connection string will not parse. Choosing here
 * makes it an input to planning instead of an outcome of it.
 *
 * The guidance travels to the agent as *context*, not as a prompt template: templates stay pinned
 * in the worker image (ARCHITECTURE.md §4), while what a specific project is built against is data
 * the backend owns, like the requirement text itself.
 */
export const DATABASE_CHOICES = {
  sqlserver: {
    label: 'SQL Server / Azure SQL',
    guidance:
      'Use Microsoft SQL Server (Azure SQL). The application reads its connection string from ' +
      '`DATABASE_URL`, in the form ' +
      '`sqlserver://host:1433;database=NAME;user=USER;password=PASSWORD;encrypt=true`. ' +
      'Pick a client and ORM that accept that form, and declare `DATABASE_URL` as a required ' +
      'credential.',
  },
  postgres: {
    label: 'PostgreSQL',
    guidance:
      'Use PostgreSQL. The application reads its connection string from `DATABASE_URL`, in the ' +
      'form `postgres://USER:PASSWORD@host:5432/NAME`. Declare `DATABASE_URL` as a required ' +
      'credential.',
  },
  mysql: {
    label: 'MySQL',
    guidance:
      'Use MySQL. The application reads its connection string from `DATABASE_URL`, in the form ' +
      '`mysql://USER:PASSWORD@host:3306/NAME`. Declare `DATABASE_URL` as a required credential.',
  },
  mongodb: {
    label: 'MongoDB',
    guidance:
      'Use MongoDB. The application reads its connection string from `MONGODB_URI`, in the form ' +
      '`mongodb+srv://USER:PASSWORD@cluster/NAME`. Model the data for a document store rather ' +
      'than porting a relational schema, and declare `MONGODB_URI` as a required credential.',
  },
  /** No constraint — the agent chooses, which is how every project behaved before this existed. */
  unset: { label: 'Let the planner decide', guidance: '' },
} as const;

export type DatabaseChoice = keyof typeof DATABASE_CHOICES;

export const DATABASE_IDS = Object.keys(DATABASE_CHOICES) as DatabaseChoice[];

/**
 * What a project gets when nothing was chosen — including the projects that existed before this
 * field did, since Mongoose fills a missing path with the default when the document is read.
 */
export const DEFAULT_DATABASE: DatabaseChoice = 'sqlserver';

/** The constraint handed to an agent, or null when the project imposes none. */
export function databaseConstraint(
  id: DatabaseChoice | undefined | null,
): { id: DatabaseChoice; label: string; guidance: string } | null {
  const choice = id ?? DEFAULT_DATABASE;
  const entry = DATABASE_CHOICES[choice];
  if (!entry || entry.guidance === '') {
    return null;
  }
  return { id: choice, label: entry.label, guidance: entry.guidance };
}

/**
 * The human name of each choice, keyed by its id.
 *
 * The technical-details table compares what a requirement *says* ("MongoDB") with what the project
 * has *chosen* (`mongodb`), and those have to be the same words or the same decision reads as two.
 */
export const DATABASE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(DATABASE_CHOICES).map(([id, entry]) => [id, entry.label]),
);

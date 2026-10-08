/**
 * The technical decisions a product cannot be built without, and where each one came from.
 *
 * **The failure this exists for.** A requirement that never mentions a frontend framework is
 * planned anyway, and the agent picks one. Nobody is asked; nobody notices until the code exists.
 * The Employee Management System's plan named PostgreSQL while the project was pinned to SQL
 * Server — an assumption made in silence, surfacing only when a connection string refused to parse.
 *
 * **And the opposite failure, which is just as bad.** Asking a person for something their own
 * requirement already says, in its own words, is how a tool teaches people to click past its
 * questions. So detection comes first and asking comes last:
 *
 * ```
 * requirement → detect what it says → fall back to the project's configuration → ask for the rest
 * ```
 *
 * Detection is deliberately **literal**: a technology counts as chosen only when the requirement
 * names it. Guessing "React" from the word "modern" would be worse than asking, because a wrong
 * answer presented as detected is one nobody re-reads.
 */

import { splitByScope } from './requirement-scope';

export type TechnicalField =
  | 'frontend'
  | 'language'
  | 'uiFramework'
  | 'backend'
  | 'database'
  | 'databaseName'
  | 'auth'
  | 'integrations';

/** Where a value came from — shown beside it, so a reader can tell a fact from a default. */
export type DetailSource = 'requirement' | 'project' | 'missing';

export interface TechnicalDetail {
  field: TechnicalField;
  label: string;
  value: string | null;
  source: DetailSource;
  /** Whether planning should stop and ask when this is missing. */
  required: boolean;
  /** What to ask, when it is missing and required. */
  question: string;
}

interface FieldSpec {
  label: string;
  required: boolean;
  question: string;
  /** Canonical name → the ways a requirement might write it. Order decides precedence. */
  vocabulary: [string, RegExp][];
}

/**
 * How each technology is recognised.
 *
 * Whole-word, case-insensitive, and only names a person would actually write. The cost of a false
 * positive is higher than a false negative: an undetected framework becomes a question, while a
 * wrongly detected one becomes a silent decision.
 */
const FIELDS: Record<TechnicalField, FieldSpec> = {
  frontend: {
    label: 'Frontend',
    required: true,
    question:
      'Which frontend framework should this be built with — React, Angular, Vue, or something else?',
    vocabulary: [
      ['Next.js', /\bnext\.?js\b/i],
      ['React', /\breact(?:\.js)?\b/i],
      ['Angular', /\bangular\b/i],
      ['Vue', /\bvue(?:\.js)?\b/i],
      ['Svelte', /\bsvelte(?:kit)?\b/i],
      ['Blazor', /\bblazor\b/i],
    ],
  },
  language: {
    label: 'Language',
    required: true,
    question:
      'Which language should the code be written in — TypeScript, JavaScript, C#, Python, or something else?',
    vocabulary: [
      ['TypeScript', /\btype\s?script\b/i],
      ['JavaScript', /\bjava\s?script\b/i],
      ['C#', /\bc#|\bc\s?sharp\b|\.net\b/i],
      ['Python', /\bpython\b/i],
      ['Java', /\bjava\b(?!\s?script)/i],
      ['Go', /\bgolang\b/i],
    ],
  },
  uiFramework: {
    label: 'UI framework',
    required: false,
    question:
      'Which component or CSS framework should the interface use — Ant Design, Material UI, Tailwind, or something else?',
    vocabulary: [
      ['Ant Design', /\bant\s?design\b|\bantd\b/i],
      ['Material UI', /\bmaterial[-\s]?ui\b|\bmui\b/i],
      ['Tailwind', /\btailwind(?:\s?css)?\b/i],
      ['Bootstrap', /\bbootstrap\b/i],
      ['Chakra UI', /\bchakra(?:\s?ui)?\b/i],
      ['Fluent UI', /\bfluent\s?ui\b/i],
    ],
  },
  backend: {
    label: 'Backend',
    required: true,
    question:
      'What should the backend be built with — Node.js, .NET, Python, or something else? Say so if the product has no backend at all.',
    vocabulary: [
      ['NestJS', /\bnest\.?js\b/i],
      ['Express', /\bexpress(?:\.js)?\b/i],
      ['Node.js', /\bnode(?:\.?js)?\b/i],
      ['ASP.NET', /\basp\.?net\b/i],
      ['Django', /\bdjango\b/i],
      ['FastAPI', /\bfast\s?api\b/i],
      ['Flask', /\bflask\b/i],
      ['Spring Boot', /\bspring\s?boot\b/i],
    ],
  },
  database: {
    label: 'Database',
    required: true,
    question:
      'Which database should this use — SQL Server, PostgreSQL, MySQL, MongoDB, or something else? Say so if nothing is stored on a server.',
    vocabulary: [
      ['SQL Server', /\bsql\s?server\b|\bazure\s?sql\b|\bmssql\b/i],
      ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
      ['MySQL', /\bmy\s?sql\b/i],
      ['MongoDB', /\bmongo(?:db)?\b/i],
      ['SQLite', /\bsqlite\b/i],
      ['Cosmos DB', /\bcosmos\s?db\b/i],
    ],
  },
  databaseName: {
    label: 'Database name',
    required: false,
    question:
      'What should the database itself be called — the name the application connects to, such as appointment_booking? This is the name, not the kind of database.',
    vocabulary: [], // not a vocabulary — see detectDatabaseName
  },
  auth: {
    label: 'Authentication',
    required: true,
    question:
      'How should people sign in — a seeded administrator, username and password, Entra ID, OAuth? Say so if the product needs no sign-in.',
    vocabulary: [
      ['Entra ID', /\bentra\s?id\b|\bazure\s?ad\b/i],
      ['OAuth', /\boauth2?\b/i],
      ['Auth0', /\bauth0\b/i],
      ['JWT', /\bjwt\b|\bjson\s?web\s?token\b/i],
      ['No sign-in', /\bno\s(?:sign[-\s]?in|login|authentication|auth)\b/i],
      // Naming a login *screen* is not choosing how people sign in. The dark-mode requirement for
      // the Employee Management System lists "Login screen" among the screens that must support
      // both themes, and the old pattern read that as the project's authentication decision.
      [
        'Username and password',
        /\b(?:username|email)\s+and\s+password\b|\bpassword[-\s]based\b|\bbasic\s+auth(?:entication)?\b/i,
      ],
    ],
  },
  integrations: {
    label: 'Integrations',
    required: false,
    question:
      'Does this need to talk to anything outside itself — email, payments, a third-party API?',
    vocabulary: [
      // Sending mail, not the word "email". A requirement that has an email *field* is not a
      // requirement that talks to a mail service, and the Quiz Generator's excluded "Email
      // Notifications" matched the old bare pattern twice over.
      [
        'Email',
        /\b(?:send|sends|sending|sent)\s+(?:an?\s+|the\s+)?e-?mails?\b|\be-?mail\s+notification(?:s)?\b|\bsmtp\b|\bsendgrid\b|\be-?mail\s+service\b/i,
      ],
      // Taking money, not the word "payment". An expense tracker records a *payment method* —
      // Cash, Card, UPI — as a field on a row it stores; it never talks to a payment provider.
      [
        'Payments',
        /\bpayment\s+gateway\b|\b(?:process|take|accept|collect|receive)(?:s|es|ing)?\s+(?:online\s+)?payments?\b|\bstripe\b|\brazorpay\b|\bpaypal\b|\bcheckout\s+flow\b/i,
      ],
      ['File storage', /\bblob\s?storage\b|\bs3\b|\bfile\s+upload(?:s)?\b/i],
      // A bare "notification" is a word products use about themselves; only a named mechanism is
      // evidence that something outside the product is involved.
      [
        'Notifications',
        /\bpush\s+notification(?:s)?\b|\bnotification\s+service\b|\bin[-\s]?app\s+notification(?:s)?\b|\bweb\s?push\b/i,
      ],
    ],
  },
};

export const TECHNICAL_FIELDS = Object.keys(FIELDS) as TechnicalField[];

/**
 * The usual answers for each field, for a screen to offer rather than make someone type.
 *
 * Deliberately the same vocabulary that detects a technology in a requirement, so the list a
 * person picks from and the list their requirement is read against cannot drift apart — a
 * choice offered here is one the detector will recognise if it is later written into a
 * requirement instead.
 *
 * A convenience, never a constraint. Every field stays free text: a product built with
 * something not on this list is still a product this tool has to be able to plan, and
 * `databaseName` has no list at all because a name is not chosen from a menu.
 */
export const TECHNICAL_FIELD_OPTIONS: Record<TechnicalField, string[]> = Object.fromEntries(
  TECHNICAL_FIELDS.map((field) => [field, FIELDS[field].vocabulary.map(([name]) => name)]),
) as Record<TechnicalField, string[]>;

/**
 * What it looks like for a field to be ruled *out*, rather than chosen.
 *
 * Broader than the vocabularies on purpose: a requirement excluding a database writes "Database
 * integration", not "PostgreSQL". Only used against text the requirement has already marked as
 * out of scope, so a loose match here cannot invent a decision — it can only record a refusal
 * the requirement already made in plain words.
 */
const EXCLUSION_CONCEPT: Partial<Record<TechnicalField, RegExp>> = {
  database: /\bdatabases?\b|\bpersistence\b|\bdata\s+storage\b|\bstorage\s+layer\b/i,
  databaseName: /\bdatabases?\b/i,
  auth: /\bauthentication\b|\bauthori[sz]ation\b|\bsign[-\s]?in\b|\blog[-\s]?in\b|\buser\s+management\b|\bidentity\b/i,
  backend: /\bbackend\b|\bserver[-\s]side\b|\bapi\s+layer\b/i,
  integrations: /\bintegrations?\b|\bthird[-\s]party\b/i,
};

/** The value shown for something the requirement explicitly refused. */
export const OUT_OF_SCOPE = 'Out of scope';

/** Whether the requirement's excluded section rules this field out altogether. */
function isExcluded(field: TechnicalField, excluded: string): boolean {
  if (!excluded.trim()) return false;
  const concept = EXCLUSION_CONCEPT[field];
  if (concept?.test(excluded)) return true;
  // A named technology in the excluded list rules the field out just as clearly: "no MongoDB".
  return FIELDS[field].vocabulary.some(([, pattern]) => pattern.test(excluded));
}

/** The first technology in a field's vocabulary that the text names, or null. */
function detectField(field: TechnicalField, text: string): string | null {
  for (const [name, pattern] of FIELDS[field].vocabulary) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/**
 * Every integration the text names, not just the first — a product may send email *and* take
 * payments, and reporting one of them would be worse than reporting neither.
 */
function detectIntegrations(text: string): string | null {
  const found = FIELDS.integrations.vocabulary
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  return found.length > 0 ? found.join(', ') : null;
}

/**
 * A database name, which is written rather than chosen from a list.
 *
 * Only the phrasings that genuinely name one — "database named X", "database called X", "the X
 * database". A bare capitalised word near the word "database" is not a name, and treating it as
 * one would put a product's data somewhere nobody intended.
 */
/**
 * Words that answer "which kind of database", not "what is it called".
 *
 * "Database: SQL" in a requirement's technical section states the *type*; reading it as the name
 * would have the Expense Tracker's database christened "SQL". A product name is caught by the
 * database vocabulary for the same reason: "Database: PostgreSQL" names no database either.
 */
const NOT_A_DATABASE_NAME = /^(?:sql|nosql|no-sql|relational|database|db|rdbms|any|tbd|none)$/i;

export function isDatabaseType(value: string): boolean {
  if (NOT_A_DATABASE_NAME.test(value)) return true;
  return FIELDS.database.vocabulary.some(([, pattern]) => pattern.test(value));
}

export function detectDatabaseName(text: string): string | null {
  const patterns = [
    /\bdatabase\s+(?:is\s+)?(?:named|called)\s+[`'"]?([A-Za-z][\w-]{2,63})[`'"]?/i,
    /\bdb\s+(?:named|called)\s+[`'"]?([A-Za-z][\w-]{2,63})[`'"]?/i,
    /\bdatabase\s*(?:=|:)\s*[`'"]?([A-Za-z][\w-]{2,63})[`'"]?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text ?? '');
    if (match && !isDatabaseType(match[1])) return match[1];
  }
  return null;
}

/**
 * Everything the requirement itself asks for, field by field.
 *
 * Reads only the in-scope half. A technology named in a list of things the product will *not*
 * have is not a choice, and reading it as one is how "out of scope: Email Notifications" became
 * two integrations nobody asked for.
 */
export function detectFromRequirement(
  requirementText: string,
): Partial<Record<TechnicalField, string>> {
  const text = splitByScope(requirementText ?? '').inScope;
  const found: Partial<Record<TechnicalField, string>> = {};
  for (const field of TECHNICAL_FIELDS) {
    const value =
      field === 'databaseName'
        ? detectDatabaseName(text)
        : field === 'integrations'
          ? detectIntegrations(text)
          : detectField(field, text);
    if (value) found[field] = value;
  }
  return found;
}

/** What the project already decided, independent of any requirement. */
export interface ProjectTechnicalConfig {
  database?: string | null;
  uiFramework?: string | null;
}

/**
 * Each technical detail with its value and where that value came from.
 *
 * The order is the whole point: what the requirement says wins, the project's own configuration
 * fills the gaps, and only what is left over is ever asked about.
 */
export function resolveTechnicalDetails(
  requirementText: string,
  project: ProjectTechnicalConfig = {},
  /**
   * What the product was already built with, from the plan that built it.
   *
   * An enhancement's requirement talks about the change, not the stack: "add a dark mode" names
   * no frontend, no language and no backend, so a change to a working React product read as a
   * fresh requirement would report three gaps and ask three questions whose answers are sitting
   * in the repository. Ranked with the project's own configuration, because that is what it is.
   */
  inherited: Partial<Record<TechnicalField, string>> = {},
): TechnicalDetail[] {
  const detected = detectFromRequirement(requirementText);
  const { excluded } = splitByScope(requirementText ?? '');
  const fromProject: Partial<Record<TechnicalField, string | null | undefined>> = {
    database: project.database,
    uiFramework: project.uiFramework,
  };

  return TECHNICAL_FIELDS.map((field) => {
    const spec = FIELDS[field];
    const fromRequirement = detected[field];
    const configured = fromProject[field];

    const detail = (value: string | null, source: DetailSource) => ({
      field,
      label: spec.label,
      value,
      source,
      required: spec.required,
      question: spec.question,
    });

    if (fromRequirement) return detail(fromRequirement, 'requirement');
    if (configured) return detail(configured, 'project');
    // What the product was already built with, carried into a change request.
    if (inherited[field]) return detail(inherited[field] as string, 'project');

    /*
     * A refusal is an answer, and the most explicit one there is. The Quiz Generator's requirement
     * says in so many words that authentication and database integration are out of scope; asking
     * "which database should this use?" and blocking approval until someone answers would be the
     * tool arguing with a document it was given.
     *
     * **Last, though**, and that ordering is the whole of it. The dark-mode change to the Employee
     * Management System rules backend and database work out of scope — of *that change*. The
     * product still runs on SQL Server, and answering "Database: out of scope" for a product with
     * a live database would be a worse lie than the question it saves. An exclusion says what is
     * not being done; it cannot unmake something that already exists.
     */
    if (isExcluded(field, excluded)) return detail(OUT_OF_SCOPE, 'requirement');

    return detail(null, 'missing');
  });
}

/**
 * The shape these rules actually need.
 *
 * Deliberately looser than {@link TechnicalDetail}: the same rules are applied to details read
 * back from MongoDB, where `field` and `source` are plain strings. Demanding the literal union
 * would force a cast at every call site, and a cast is a place a real mismatch could hide.
 */
export interface DetailLike {
  field: string;
  label: string;
  value: string | null;
  source: string;
  required: boolean;
  question: string;
}

/**
 * The questions planning should actually ask: required details nobody has answered.
 *
 * A detail is answered by *anyone* — the requirement, the project, or a person. Only `missing`
 * remains a question. Optional details that are missing are left alone: a product that mentions
 * no integrations probably has none, and asking anyway is the noise that makes people stop
 * reading the questions.
 */
export function unansweredQuestions<T extends DetailLike>(details: readonly T[]): T[] {
  return (details ?? []).filter((detail) => detail.required && detail.source === 'missing');
}

/** Whether planning can proceed without asking anything. */
export function isComplete(details: readonly DetailLike[]): boolean {
  return unansweredQuestions(details).length === 0;
}

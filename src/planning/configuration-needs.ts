import { planSection } from './plan-validation';
import { UiStyleChoice } from '../projects/ui-style-choice';

/** What a plan implies the project still has to be configured with. */
export interface ConfigurationNeeds {
  /** The product stores data, so a database has to be chosen before it can be built. */
  needsDatabase: boolean;
  /** Why the database question is being asked — the plan's own words, for the person answering. */
  databaseEvidence: string | null;
  /**
   * The plan states the product keeps nothing on a server, so a database is not needed.
   *
   * Distinct from `needsDatabase: false`, which only means nothing was found. This one is a stated
   * decision, and worth showing as such rather than as silence.
   */
  serverless: boolean;
  /** The repositories the plan describes, as names, in the order they appear. */
  repositories: string[];
  /**
   * The interface framework the plan names, or null when it names none.
   *
   * A requirement that asks for Material UI has to produce a product built with it. Handing the
   * agent a different framework as a constraint — because one was chosen on a form before anyone
   * had read the requirement — would contradict the thing that was actually asked for.
   */
  uiStyle: UiStyleChoice | null;
}

/** How each interface framework names itself in prose. Order matters: the first match wins. */
const UI_STYLE_WORDS: { id: UiStyleChoice; pattern: RegExp }[] = [
  { id: 'mui', pattern: /\b(material[- ]?ui|mui)\b/i },
  { id: 'antd', pattern: /\b(ant design|antd)\b/i },
  { id: 'tailwind', pattern: /\btailwind\b/i },
  { id: 'css', pattern: /\b(plain css|vanilla css|hand[- ]written css)\b/i },
];

/** Words that only appear in a plan for something that keeps data between requests. */
const PERSISTENCE =
  /\b(database|persist(?:ence|ed|s)?|schema|migration|repository pattern|data model|entity|entities|stored? in|CRUD|table|collection)\b/i;

/**
 * A plan saying outright that the product has no server side.
 *
 * This has to be read *before* anything else, because the words that normally mean "there is a
 * database" appear in these sentences too — in the negative. The first real plan this ran against
 * said "without a server, a database, or an account" and "no backend, no API, no database", and was
 * read as needing both a database and an API repository purely from the nouns being present.
 *
 * Browser storage is the same distinction: a focus timer that keeps today's sessions across a page
 * refresh genuinely persists data, and still needs no database.
 */
const NO_SERVER_SIDE = new RegExp(
  [
    // Deliberately narrow. "no API versioning" and "users can try it without an account" are
    // ordinary sentences in a plan that very much has a server, so neither counts here.
    '\\bno (?:back[- ]?end|server|database|persistence|server[- ]side)\\b',
    '\\bwithout (?:a |an |any )?(?:server|back[- ]?end|database)\\b',
    '\\bbrowser[- ]only\\b',
    '\\bclient[- ]side only\\b',
    '(?:runs?|lives?|happens?|stays?) (?:entirely |wholly |only )?in the browser',
    "browser'?s own storage",
    '\\b(?:localstorage|sessionstorage|indexeddb)\\b',
  ].join('|'),
  'i',
);

/**
 * Does the plan state that the product keeps nothing on a server?
 *
 * An explicit statement wins over inference: a plan that says so is describing a decision already
 * taken, while everything else here is a guess from vocabulary.
 */
export function isServerless(markdown: string): boolean {
  return NO_SERVER_SIDE.test(markdown ?? '');
}

/**
 * Words for the two halves of a product. A plan rarely names its repositories outright, but it is
 * always explicit about having an interface and a server.
 */
const API_WORDS = /\b(api|backend|server|endpoint|REST|service layer)\b/i;
const UI_WORDS = /\b(UI|user interface|frontend|front-end|screen|page|component)\b/i;

/** An explicit repository name, e.g. `repo: expense-api` or "repository `expense-ui`". */
const NAMED_REPO = /(?:repo(?:sitory)?)\s*[:=]?\s*[`'"]?([a-z0-9][a-z0-9._-]{1,60})[`'"]?/gi;

/** A name Azure DevOps will accept, derived from the product's own name. */
export function repoNameFor(productName: string, role: 'api' | 'ui'): string {
  const base =
    productName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'product';
  return `${base}-${role}`;
}

/**
 * Reads a plan and says what still has to be decided before the product can be built.
 *
 * The alternative — asking for a database and repositories on the way in — means asking before
 * anyone knows whether the product needs them, which is how a project ends up configured for a
 * database it never uses and repositories that do not match what was planned. The plan is the first
 * moment the answer is actually knowable, so it is the first moment worth asking.
 *
 * `productName` only seeds suggested repository names; the person can change them.
 */
export function configurationNeeds(markdown: string, productName: string): ConfigurationNeeds {
  const plan = markdown ?? '';
  // Read the explicit statement first: the vocabulary of persistence and of servers appears in the
  // sentences that rule them out, so inferring from it before reading those is how a browser-only
  // product gets asked for a database and an API repository.
  const serverless = isServerless(plan);
  const evidence = serverless ? null : firstMatchingLine(plan, PERSISTENCE);

  const repositories = explicitRepositories(plan);
  if (repositories.length === 0) {
    // Nothing named, so fall back to the shape the plan describes.
    if (!serverless && API_WORDS.test(plan)) repositories.push(repoNameFor(productName, 'api'));
    if (UI_WORDS.test(plan)) repositories.push(repoNameFor(productName, 'ui'));
  }

  return {
    needsDatabase: evidence !== null,
    databaseEvidence: evidence,
    serverless,
    repositories,
    uiStyle: UI_STYLE_WORDS.find((s) => s.pattern.test(plan))?.id ?? null,
  };
}

/**
 * The first line that matches, trimmed of bullet markers — quoted back as the reason.
 *
 * A line that also denies a server side is skipped: quoting "runs without a database" as the reason
 * a database is needed is worse than quoting nothing.
 */
function firstMatchingLine(markdown: string, pattern: RegExp): string | null {
  for (const line of markdown.split('\n')) {
    const text = line.replace(/^\s*[-*]\s*/, '').trim();
    if (text && !text.startsWith('#') && pattern.test(text) && !NO_SERVER_SIDE.test(text)) {
      return text.length > 200 ? `${text.slice(0, 197)}...` : text;
    }
  }
  return null;
}

/** Repository names the plan states outright, deduplicated, in order. */
function explicitRepositories(markdown: string): string[] {
  // Only trust a section that is about repositories; 'repository pattern' in an architecture
  // paragraph is not a repository name.
  const section =
    planSection(markdown, /^\s*#{1,4}\s*(repositor|source control|code layout)/i) ||
    markdown
      .split('\n')
      .filter((l) => /^\s*[-*]?\s*repo(sitory)?\s*[:=]/i.test(l))
      .join('\n');
  const names: string[] = [];
  for (const match of section.matchAll(NAMED_REPO)) {
    const name = match[1].toLowerCase();
    if (name !== 'pattern' && !names.includes(name)) names.push(name);
  }
  return names;
}

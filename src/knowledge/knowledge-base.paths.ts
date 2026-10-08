/**
 * Where a project's knowledge base lives in Blob Storage.
 *
 * ```
 * <container>/
 *   6abe2b5bd8ca853c7a61bd31/
 *     knowledge-base/
 *       architecture.md
 *       conventions.md
 * ```
 *
 * **Derived from the project id, never stored.** The obvious alternative — a `knowledgeBasePath`
 * on the project record — is a second source of truth for something that already has one, and this
 * system has been bitten by that repeatedly: a theme file saying the header is white while the
 * component made the text white, a plan naming PostgreSQL while the project was pinned to SQL
 * Server, a prompt allowing a link type the code could not read. Two places that must agree
 * eventually stop agreeing, and nothing notices.
 *
 * A path that can be computed is not configuration. If a project ever genuinely needs its knowledge
 * base somewhere else, that is the point to add a stored override — not before.
 */

/** The folder inside a project's area that holds its knowledge base. */
const FOLDER = 'knowledge-base';

/** Where a project's knowledge base lives, relative to the container. No trailing slash. */
export function kbPrefix(projectId: string): string {
  const id = (projectId ?? '').trim();
  if (!id) throw new Error('A knowledge base needs a project id.');
  return `${id}/${FOLDER}`;
}

/**
 * A document name safe to use as part of a blob key.
 *
 * Deliberately strict: lowercase, words and dashes, one `.md`. A knowledge base is read by name —
 * a prompt says "read conventions.md" — so the names have to be predictable, and a name carrying a
 * slash would silently place a document in a folder nobody is looking in.
 */
export function kbDocName(name: string): string {
  const cleaned = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!cleaned) throw new Error(`'${name}' is not a usable knowledge base document name.`);
  return `${cleaned}.md`;
}

/** The full blob key for one document. */
export function kbKey(projectId: string, name: string): string {
  return `${kbPrefix(projectId)}/${kbDocName(name)}`;
}

/** The document name back out of a key, or null when the key is not this project's. */
export function kbDocOf(projectId: string, key: string): string | null {
  const prefix = `${kbPrefix(projectId)}/`;
  if (!key?.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  // One level only. A key with a slash left in it is not a document this reads.
  return rest && !rest.includes('/') ? rest : null;
}

/**
 * The documents the orchestrator writes and the agents are told to read.
 *
 * Named rather than numbered (`KB-01`) so a person browsing the container can tell what is there,
 * and so a prompt can point at one document instead of "everything".
 */
export const KB_ARCHITECTURE = 'architecture.md';
export const KB_CONVENTIONS = 'conventions.md';
export const KB_DOCS = [KB_ARCHITECTURE, KB_CONVENTIONS] as const;

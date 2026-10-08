/** The kind of change a backlog item claims to make. */
export type Operation = 'create' | 'update' | 'delete' | 'read';

/**
 * How each operation is written about, in titles and in acceptance criteria.
 *
 * Deliberately the words people actually use — the HTTP method, the verb, and the noun form —
 * because a Story is titled "PUT /employees/:id (update)" and its criteria say "updates the
 * employee and returns 200". Both have to be recognised as the same thing.
 */
const VOCABULARY: Record<Operation, RegExp> = {
  create: /\b(POST|create[sd]?|creating|creation|add(?:s|ed|ing)?|insert(?:s|ed|ing)?|201)\b/i,
  update:
    /\b(PUT|PATCH|update[sd]?|updating|edit(?:s|ed|ing)?|modif(?:y|ies|ied)|amend(?:s|ed)?)\b/i,
  delete:
    /\b(DELETE|delete[sd]?|deleting|deletion|remov(?:e|es|ed|ing|al)|destroy(?:s|ed)?|204)\b/i,
  read: /\b(GET|list(?:s|ed|ing)?|search(?:es|ed|ing)?|fetch(?:es|ed|ing)?|retrieve[sd]?|view(?:s|ed)?)\b/i,
};

/**
 * An HTTP method named outright in a title.
 *
 * The only completely unambiguous claim an item can make. "PUT /employees/:id" is about updating
 * and nothing else, whereas "Add response-schema validation tests" merely begins with "Add".
 */
const HTTP_METHOD = /\b(POST|PUT|PATCH|DELETE|GET)\b/;

export function namesHttpMethod(title: string): boolean {
  return HTTP_METHOD.test(title ?? '');
}

/** Every operation the text talks about. */
export function operationsIn(text: string): Operation[] {
  const body = text ?? '';
  return (Object.keys(VOCABULARY) as Operation[]).filter((op) => VOCABULARY[op].test(body));
}

/**
 * The single operation a title claims, or null when it claims none or several.
 *
 * Only an unambiguous title is worth checking against. "Employee API" names no operation, and
 * "Create and update an employee" names two — neither is a contradiction waiting to happen, and
 * guessing at them would produce exactly the noisy false positives that make a gate ignored.
 */
export function claimedOperation(title: string): Operation | null {
  const found = operationsIn(title);
  return found.length === 1 ? found[0] : null;
}

/**
 * Do the acceptance criteria describe something other than what the title says?
 *
 * Returns the operation they describe instead, or null when there is no contradiction.
 *
 * The failure this exists for: a Story titled `PUT /employees/:id (update)` whose criteria read
 * "creates the employee, persists it, and returns 201 with the created employee", and the DELETE
 * Story beneath it carrying the update criteria. Every criterion was well-formed, every other gate
 * passed, and the whole set was shifted by one. It matters because **QA verifies against the
 * acceptance criteria**: a delete Story checked against update criteria passes while delete is
 * broken, which is the exact failure a Definition of Done is written to prevent.
 *
 * The test is deliberately strict about what counts as wrong: the criteria must never mention the
 * claimed operation *at all*, and must clearly describe a different one. Criteria that mention
 * both — "deleting it removes it from the list returned by GET" — are a Story doing its job.
 */
export function contradictedBy(title: string, acceptanceCriteria: string): Operation | null {
  const claimed = claimedOperation(title);
  if (!claimed) return null;

  const criteria = (acceptanceCriteria ?? '').trim();
  if (!criteria) return null; // absent criteria are a different problem, reported elsewhere

  const described = operationsIn(criteria);
  if (described.includes(claimed)) return null;

  // `read` is the weakest signal — almost every criterion mentions a list or a GET somewhere — so
  // it is never on its own enough to call a Story wrong.
  const contradicting = described.filter((op) => op !== 'read');
  return contradicting[0] ?? null;
}

/** Words too ordinary to tell one item from another. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'all',
  'its',
  'are',
  'be',
  'by',
  'as',
  'or',
  'not',
  'no',
  'so',
  'it',
  'into',
  'per',
  'via',
  'when',
  'then',
  'only',
  'every',
  'each',
  'any',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
]);

/** The words of a piece of text, cut to a stem so "protecting" and "protect" match. */
function stems(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    .map((w) => w.slice(0, 5));
}

/**
 * Do an item's acceptance criteria talk about anything its own title mentions?
 *
 * The CRUD criteria in one backlog were shifted by one *twice*: first onto the wrong HTTP-method
 * Stories, then — after a correction round — onto "Logout endpoint and session invalidation" and
 * "Auth middleware protecting all employee endpoints", whose criteria described creating and
 * updating an employee. Those titles name no operation at all, so comparing the operation claimed
 * against the operation described could not see them.
 *
 * What it can see is that the criteria never mention logout, session, auth or middleware. The
 * words that make a title distinctive are worked out from the backlog itself — a word in many
 * titles ("employee", "endpoint") says nothing about any one item, while a word in few says a
 * great deal — so nothing has to be hand-listed per project.
 *
 * `allTitles` is every title in the backlog, which is what makes "common" mean something.
 */
export function criteriaIgnoreTitle(
  title: string,
  acceptanceCriteria: string,
  allTitles: string[],
): boolean {
  const criteria = (acceptanceCriteria ?? '').trim();
  if (!criteria) return false;

  // Only worth asking when the criteria clearly describe changing something. Reading is mentioned
  // everywhere, and criteria about neither are prose this cannot judge.
  const describes = operationsIn(criteria).filter((op) => op !== 'read');
  if (describes.length === 0) return false;

  const titles = allTitles ?? [];
  const frequency = new Map<string, number>();
  for (const other of titles) {
    for (const w of new Set(stems(other))) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  }
  const tooCommon = (w: string) => (frequency.get(w) ?? 0) > titles.length * 0.15;

  const distinctive = [...new Set(stems(title))].filter((w) => !tooCommon(w));
  if (distinctive.length === 0) return false; // nothing distinctive to look for

  const body = new Set(stems(criteria));
  return !distinctive.some((w) => body.has(w));
}

/** How to say an operation in a sentence. */
export function describeOperation(op: Operation): string {
  return { create: 'creating', update: 'updating', delete: 'deleting', read: 'reading' }[op];
}

/**
 * The questions worth asking about a requirement, and the ones that must never be asked.
 *
 * **The failure this exists for.** `student management for college` — four words — produced a full
 * plan with six epics and not one question. Across every project ever planned here the number of
 * clarifications asked is **zero**. The machinery was never broken: the Engineering Manager posts
 * questions, the draft stores them, the page answers them. The *instruction* was one conditional
 * bullet among a dozen output rules, in a template whose every other line says "produce a plan" —
 * so the agent produced a plan, every time, and invented the categories, the roles, the business
 * rules and the edge cases that nobody had specified.
 *
 * **And the opposite failure, which is why this is not simply "ask more".** A tool that asks
 * fifteen questions, four of which the requirement already answers, teaches people to skim and
 * click past. {@link ./technical-details.ts} exists because of exactly that, for the technology
 * stack. This is the same rule applied to everything else a product needs decided: what it does,
 * who may do it, what the data is, and what happens at the edges.
 *
 * The order is the whole design:
 *
 * ```
 * requirement -> existing project configuration -> previously confirmed decisions -> ask
 * ```
 *
 * Only what survives all three is a question.
 */

/**
 * The dimensions a requirement can be unclear in.
 *
 * Deliberately broader than technology. A plan can name React, TypeScript and SQL Server and still
 * be unbuildable because nobody said whether one user may delete another's record — and that gap
 * costs more than a missing framework, because the framework is noticed on day one and the
 * permission rule is noticed in production.
 */
export const CLARIFICATION_CATEGORIES = [
  'functional',
  'business-rules',
  'roles',
  'data',
  'ux',
  'validation',
  'edge-cases',
  'integrations',
  'technical',
] as const;

export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];

/** How each category reads on screen. */
export const CATEGORY_LABELS: Record<ClarificationCategory, string> = {
  functional: 'What it does',
  'business-rules': 'Business rules',
  roles: 'Roles and permissions',
  data: 'Data',
  ux: 'Look and behaviour',
  validation: 'Validation',
  'edge-cases': 'Edge cases',
  integrations: 'Integrations',
  technical: 'Technical',
};

/** What an agent might write for each category, beyond the canonical name. */
const CATEGORY_ALIASES: Record<string, ClarificationCategory> = {
  functional: 'functional',
  function: 'functional',
  feature: 'functional',
  behaviour: 'functional',
  behavior: 'functional',
  flow: 'functional',
  'user-flow': 'functional',
  business: 'business-rules',
  'business-rule': 'business-rules',
  'business-rules': 'business-rules',
  rule: 'business-rules',
  roles: 'roles',
  role: 'roles',
  permission: 'roles',
  auth: 'roles',
  authorisation: 'roles',
  authorization: 'roles',
  authentication: 'roles',
  data: 'data',
  model: 'data',
  'data-model': 'data',
  schema: 'data',
  field: 'data',
  ux: 'ux',
  ui: 'ux',
  'ui-ux': 'ux',
  design: 'ux',
  interface: 'ux',
  validation: 'validation',
  'edge-case': 'edge-cases',
  'edge-cases': 'edge-cases',
  edge: 'edge-cases',
  error: 'edge-cases',
  'error-handling': 'edge-cases',
  integration: 'integrations',
  integrations: 'integrations',
  notification: 'integrations',
  email: 'integrations',
  technical: 'technical',
  tech: 'technical',
  stack: 'technical',
  technology: 'technical',
  performance: 'technical',
  infrastructure: 'technical',
};

/**
 * The category an agent wrote, mapped onto one this system knows.
 *
 * Unrecognised text falls back to `functional` rather than being dropped. A question whose label
 * could not be parsed is still a question worth asking, and losing it to a vocabulary mismatch
 * would be the tooling discarding the very thing it exists to surface.
 */
export function normaliseCategory(raw: string | null | undefined): ClarificationCategory {
  const key = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  // Singular as a fallback, rather than listing every plural twice: "permissions" and "permission"
  // are the same word, and a map that has to remember both is a map that will one day forget one.
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  return CATEGORY_ALIASES[key] ?? CATEGORY_ALIASES[singular] ?? 'functional';
}

/** A question as it arrives from an agent, before anything has been decided about it. */
export interface ClarificationInput {
  question: string;
  category?: string | null;
  /** What goes wrong if nobody answers — the test of whether it is worth asking at all. */
  why?: string | null;
  /** What will be assumed if it goes unanswered, so that silence is still an informed choice. */
  assumption?: string | null;
}

/** A question already put to someone in this project, with whatever answer it has. */
export interface PriorClarification {
  question: string;
  answer?: string | null;
}

/**
 * The comparable form of a question.
 *
 * Case, punctuation, plurals and a little filler are dropped, so "Can users edit expenses?" and
 * "Can a user edit an expense" are recognised as the same question. Asking someone something they
 * have already answered is the fastest way to make them stop reading the questions.
 */
export function questionKey(question: string): string {
  const FILLER = ['a', 'an', 'the', 'should', 'would', 'will', 'do', 'doe', 'is', 'are', 'be'];
  return (question ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => !FILLER.includes(word))
    .join(' ');
}

export type SkipReason = 'already-answered' | 'already-asked' | 'duplicate' | 'empty';

export interface SelectionResult<T> {
  /** The questions genuinely worth putting to a person. */
  ask: T[];
  /** The ones suppressed, and why — so a silent drop can always be accounted for. */
  skipped: { question: string; reason: SkipReason }[];
}

/**
 * Decides which of an agent's questions a person actually sees.
 *
 * Three suppressions. A question is dropped when it was **already answered** in this project (the
 * "previously confirmed decisions" step — that answer is a fact, and re-asking invites a
 * contradicting one), when it is **already outstanding** (a regeneration must not stack the same
 * question twice), and when the agent asked it **twice in one batch**.
 *
 * Everything else is asked. This deliberately does not judge whether a question is *important* —
 * that is the agent's job, with the requirement in front of it. A rule here guessing importance
 * from the words alone would suppress exactly the unusual question most worth asking.
 */
export function selectClarifications<T extends ClarificationInput>(
  incoming: readonly T[],
  prior: readonly PriorClarification[] = [],
): SelectionResult<T> {
  const answered = new Set(
    (prior ?? []).filter((p) => (p.answer ?? '').trim()).map((p) => questionKey(p.question)),
  );
  const outstanding = new Set(
    (prior ?? []).filter((p) => !(p.answer ?? '').trim()).map((p) => questionKey(p.question)),
  );

  const ask: T[] = [];
  const skipped: SelectionResult<T>['skipped'] = [];
  const seen = new Set<string>();

  for (const item of incoming ?? []) {
    const question = (item?.question ?? '').trim();
    if (!question) {
      skipped.push({ question: '', reason: 'empty' });
      continue;
    }
    const key = questionKey(question);
    if (answered.has(key)) {
      skipped.push({ question, reason: 'already-answered' });
    } else if (outstanding.has(key)) {
      skipped.push({ question, reason: 'already-asked' });
    } else if (seen.has(key)) {
      skipped.push({ question, reason: 'duplicate' });
    } else {
      seen.add(key);
      ask.push({ ...item, question });
    }
  }

  return { ask, skipped };
}

/** Every question still waiting on a person. */
export function unanswered<T extends { answer?: string | null }>(items: readonly T[]): T[] {
  return (items ?? []).filter((item) => !(item.answer ?? '').trim());
}

/**
 * The decisions this project has already confirmed, for feeding back to the planning agent.
 *
 * The third step of `requirement -> configuration -> previous decisions`. An enhancement planned
 * weeks later should read what was settled rather than re-open which expense categories exist.
 */
export function confirmedDecisions(
  clarifications: readonly PriorClarification[],
): { question: string; answer: string }[] {
  return (clarifications ?? [])
    .filter((c) => (c.answer ?? '').trim())
    .map((c) => ({ question: c.question, answer: (c.answer as string).trim() }));
}

/** Groups questions by category, in the canonical order, leaving out categories with none. */
export function groupByCategory<T extends { category?: string | null }>(
  items: readonly T[],
): { category: ClarificationCategory; label: string; items: T[] }[] {
  return CLARIFICATION_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: (items ?? []).filter((item) => normaliseCategory(item.category) === category),
  })).filter((group) => group.items.length > 0);
}

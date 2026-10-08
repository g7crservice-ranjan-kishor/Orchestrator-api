import { repoNameOf } from '../development/repo-resolution';

/** What the plan must satisfy, drawn from the project's own binding choices. */
export interface PlanExpectations {
  /** The chosen UI approach's label, e.g. "Ant Design". Absent when the project imposes none. */
  uiStyleLabel?: string | null;
  /** The project's repositories (clone URLs or bare names). */
  targetRepos?: string[];
}

/** One thing the plan is missing, written as the instruction that would fix it. */
export interface PlanIssue {
  severity: 'error' | 'warning';
  /** Shown to a human in the UI. */
  message: string;
  /** Sent back to the agent verbatim as requested changes. */
  instruction: string;
}

const UI_SECTION = /^\s*#{1,4}\s*user interface\b/im;

/** Headings the UI foundation should appear under, however the agent words the epic itself. */
const FOUNDATION = [
  { label: 'a design system', pattern: /design system|theme tokens|design tokens/i },
  {
    label: 'an application shell',
    pattern: /application shell|app shell|navigation bar|layout shell/i,
  },
  {
    label: 'loading, empty and error states',
    pattern: /(loading|empty|error)\s*(\/|,|and|–|-)?\s*(loading|empty|error)/i,
  },
];

/** The body of one `##` section of the plan, by heading, or '' when it has none. */
export function planSection(markdown: string, heading: RegExp): string {
  const lines = (markdown ?? '').split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3}\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Every `- ` bullet in a section, trimmed; nested bullets are part of their parent. */
function topLevelBullets(section: string): string[] {
  const bullets: string[] = [];
  for (const line of section.split('\n')) {
    if (/^\s{0,1}[-*]\s+/.test(line)) bullets.push(line.trim());
    else if (bullets.length && line.trim()) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return bullets;
}

/** The work a risk bullet says addresses it: the text after `mitigated by:`. */
export function mitigationOf(bullet: string): string | null {
  const m = /mitigated by:\s*(.+?)\s*$/i.exec(bullet);
  const named = m?.[1]
    // Trailing punctuation comes off first, or a closing bracket followed by a full stop is no
    // longer at the end and the aside survives.
    ?.replace(/[.*_`\s]+$/g, '')
    // A trailing aside explains the mitigation; it is not part of the work item's name. Keeping it
    // meant "Settings drawer ... (documents the next-session-applies rule)." never matched the
    // Feature actually called "Settings drawer for durations and long-break interval", and a
    // perfectly good backlog was reported as leaving a risk unaddressed.
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/[.*_`\s]+$/g, '')
    .trim();
  return named ? named : null;
}

/** Each risk in the plan, with the work it names — `null` when it names none. */
export function planRisks(markdown: string): { risk: string; mitigation: string | null }[] {
  return topLevelBullets(planSection(markdown, /^#{1,4}\s*risks\b/i)).map((bullet) => ({
    risk: bullet,
    mitigation: mitigationOf(bullet),
  }));
}

/**
 * Checks that a generated plan actually reflects the project's binding choices.
 *
 * The need for this: the Engineering Manager complies with the UI rules when a human names the gap
 * in the feedback box, and omits them on a fresh run however firmly the template words them —
 * observed across five runs and three rounds of prompt strengthening. Telling the agent produces
 * compliance most of the time; only checking the output makes it reliable, and the check can
 * generate the very feedback that is known to work (D-037).
 *
 * Pure: the caller supplies the expectations, so this needs no database and no Azure DevOps.
 */
export function validatePlan(markdown: string, expected: PlanExpectations = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const plan = markdown ?? '';
  const ui = expected.uiStyleLabel?.trim();

  if (ui) {
    if (!UI_SECTION.test(plan)) {
      issues.push({
        severity: 'error',
        message: 'The plan has no "## User interface" section.',
        instruction:
          'Add the mandatory `## User interface` section, stating the UI approach named in the ' +
          'technology constraints by name, which shape of UI this domain calls for, and every ' +
          'screen the requirement implies with what the user does on each.',
      });
    }
    // Naming the approach is the difference between a plan the backlog can inherit and one that
    // leaves the choice open for a downstream agent to re-decide.
    if (!new RegExp(escape(ui), 'i').test(plan)) {
      issues.push({
        severity: 'error',
        message: `The plan never names the chosen UI approach (${ui}).`,
        instruction:
          `The technology constraints name **${ui}** as the binding UI approach. State it by ` +
          'name in the plan, do not substitute a different frontend styling approach, and do not ' +
          'leave the choice implicit or defer it to a later phase.',
      });
    }
    const missing = FOUNDATION.filter((f) => !f.pattern.test(plan)).map((f) => f.label);
    if (missing.length > 0) {
      issues.push({
        severity: 'error',
        message: `The plan does not cover ${missing.join(', ')}.`,
        instruction:
          'Add a UI foundation Epic to the Breakdown, sequenced before the screens that depend ' +
          'on it, with a Story for each of: the design system (one tokens file for colour, ' +
          'typography, spacing, radius and elevation), the application shell (header, ' +
          'navigation, signed-in user, sign out), and the loading / empty / error states every ' +
          'data view must handle.',
      });
    }
  }

  // Repository names are facts about the project. A plan that says "the backend repo" is where a
  // backlog full of invented names like `backend-api` comes from.
  const repos = (expected.targetRepos ?? []).map(repoNameOf).filter(Boolean);
  const unnamed = repos.filter((repo) => !new RegExp(escape(repo), 'i').test(plan));
  if (repos.length > 0 && unnamed.length > 0) {
    issues.push({
      severity: 'error',
      message: `The plan never names ${unnamed.join(' or ')}.`,
      instruction:
        `Name the repositories exactly as given in the technology constraints: ` +
        `${repos.join(' and ')}. Do not write "the backend repo" or "the frontend repo" — the ` +
        'backlog is built from this plan, and an unnamed repository becomes an invented one.',
    });
  }

  /*
   * A risk must name the work that addresses it.
   *
   * The plan for the last project named the risk exactly: "CORS/config mismatch between separately
   * hosted taskmanager-ui and taskmanager-api — mitigate by defining CORS and base-URL
   * configuration explicitly". It was approved, and no Story was ever created for it. The API
   * shipped with no CORS handling at all, and the interface could not call it from a browser.
   *
   * Naming a risk is not addressing it. Writing `mitigated by: <Story or Feature title>` makes the
   * claim checkable — here, that a risk names work, and in the backlog check, that the work exists.
   */
  const risks = planRisks(plan);
  const unmitigated = risks.filter((r) => !r.mitigation);
  if (risks.length > 0 && unmitigated.length > 0) {
    issues.push({
      severity: 'error',
      message: `${unmitigated.length} of ${risks.length} risk(s) name no work that addresses them.`,
      instruction:
        'End every bullet in `## Risks` with `mitigated by: <title>`, naming a Feature or Story ' +
        'that appears in your `## Breakdown` and that actually does the mitigating work. A risk ' +
        'with no work behind it is a note, not a plan: the last project named its CORS risk, ' +
        'created no Story for it, and shipped an API a browser could not call.',
    });
  }

  const titles = planSection(plan, /^#{1,4}\s*breakdown\b/i).toLowerCase();
  const dangling = risks
    .map((r) => r.mitigation)
    .filter((m): m is string => Boolean(m))
    .filter((m) => !titles.includes(m.toLowerCase().slice(0, 40)));
  if (titles && dangling.length > 0) {
    issues.push({
      severity: 'error',
      message: `${dangling.length} risk mitigation(s) name work that is not in the Breakdown.`,
      instruction:
        `These mitigations name work the Breakdown does not contain: ${dangling.join('; ')}. ` +
        'Either add that Feature or Story to the `## Breakdown`, or point the risk at work that ' +
        'is already there — spelled the same way.',
    });
  }

  return issues;
}

/** Escapes a literal for use inside a RegExp. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `## Requested changes` body for a regeneration, built from the issues themselves — the same
 * thing an admin would otherwise have to type by hand, every time.
 */
export function planFeedbackFor(issues: PlanIssue[]): string {
  return [
    ...issues.map((issue) => `- ${issue.instruction}`),
    '',
    'Keep the existing scope, phases, risks and credentials as they are.',
  ].join('\n');
}

/**
 * Drops anything the agent printed before the plan itself.
 *
 * The final message is captured verbatim, so a regeneration that opens with "Below is the revised
 * plan" — or, as happened, a `## Clarifications` heading saying there are none — leaves commentary
 * inside a document the Scrum Master later reads as the approved plan. A heading the pipeline
 * treats as meaningful is the part that matters: it does not belong in a delivery document.
 *
 * Left untouched when there is no `# Plan` heading to anchor on, so nothing is ever lost.
 */
export function stripPlanPreamble(markdown: string): string {
  const match = /^#\s+Plan\s*$/m.exec(markdown ?? '');
  return match && match.index > 0 ? markdown.slice(match.index) : (markdown ?? '');
}

/**
 * Splits a requirement into what it asks for and what it explicitly rules out.
 *
 * **The failure this exists for.** The AI Quiz Generator's requirement contains a section headed
 * "The following features are **out of scope**", listing Authentication, Database integration and
 * Email Notifications. Read as flat text, that requirement appears to *ask* for email and
 * notifications, and to be *silent* on databases and sign-in — so the stack reader reported two
 * integrations nobody wanted and would have blocked approval on two questions the requirement had
 * already answered, in the clearest terms it could.
 *
 * This is the same negation-blindness that has bitten this codebase before: a reader that matches
 * words and never sees the sentence saying *not*.
 *
 * **Deliberately conservative.** An exclusion region ends at the first line that stops looking
 * like one, because swallowing real requirements into the excluded half would be the worse
 * failure: it would silently drop work rather than merely ask one question too many.
 */

/** Phrases that introduce a list of things the product will *not* have. */
const EXCLUSION_HEADING =
  /out[-\s]of[-\s]scope|not\s+in\s+scope|outside\s+(?:the\s+)?scope|non[-\s]goals?|excluded|exclusions|will\s+not\s+(?:be\s+)?(?:built|included|implemented|supported)|future\s+(?:scope|work|phase|enhancements?)|later\s+(?:phase|release)|phase\s*2|nice[-\s]to[-\s]have/i;

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s/;
/** A bullet, a numbered item, or a table row — the shapes an exclusion list actually takes. */
const LIST_ITEM = /^\s*(?:[-*+•]\s|\d+[.)]\s|\|)/;
const BLANK = /^\s*$/;

export interface RequirementScope {
  /** Everything the requirement actually asks for. */
  inScope: string;
  /** Everything it explicitly rules out; empty when it rules out nothing. */
  excluded: string;
}

export function splitByScope(text: string): RequirementScope {
  const lines = (text ?? '').split(/\r?\n/);
  const inScope: string[] = [];
  const excluded: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!EXCLUSION_HEADING.test(line)) {
      inScope.push(line);
      i += 1;
      continue;
    }

    /*
     * The heading itself is excluded either way, but how far the exclusion reaches depends on how
     * it was written. A markdown heading owns everything up to the next heading. A sentence —
     * "The following features are out of scope:" — owns only the list that follows it, and gives
     * the document back the moment ordinary prose resumes.
     */
    excluded.push(line);
    i += 1;
    const ownsSection = MARKDOWN_HEADING.test(line);

    while (i < lines.length) {
      const next = lines[i];
      if (MARKDOWN_HEADING.test(next)) break; // a new heading always ends it
      if (!ownsSection && !BLANK.test(next) && !LIST_ITEM.test(next)) break; // prose resumed
      excluded.push(next);
      i += 1;
    }
  }

  return { inScope: inScope.join('\n'), excluded: excluded.join('\n') };
}

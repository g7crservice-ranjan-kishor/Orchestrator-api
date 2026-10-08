import { QaBoardService, qaStatusOf, toPlainText } from './qa-board.service';

/**
 * The QA view's bucketing rule. It is derived purely from Azure DevOps state + the `qa-verified`
 * tag + live run status (D-020: the work-item state is the authoritative signal), so it is worth
 * pinning down on its own — a wrong bucket sends a Story back for a second $3 test, or hides one
 * that genuinely needs testing.
 */
describe('qaStatusOf', () => {
  const base = { state: 'Done', qaVerified: false, qaRunning: false, openBugs: 0 };

  it('puts a finished, untested Story in Ready for QA', () => {
    expect(qaStatusOf(base)).toBe('Ready for QA');
  });

  it('puts a Story with a QA agent on it in Testing', () => {
    expect(qaStatusOf({ ...base, qaRunning: true })).toBe('Testing');
  });

  it('puts a QA-passed Story in Completed', () => {
    expect(qaStatusOf({ ...base, qaVerified: true })).toBe('Completed');
  });

  /** QA reopens a failed Story to Committed and files a Bug; that pairing is the failed bucket. */
  it('puts a reopened Story with an open Bug in Failed / Fix Required', () => {
    expect(qaStatusOf({ ...base, state: 'Committed', openBugs: 1 })).toBe('Failed / Fix Required');
  });

  it('hides a Story that is still being developed', () => {
    expect(qaStatusOf({ ...base, state: 'Approved' })).toBeNull();
    expect(qaStatusOf({ ...base, state: 'Committed' })).toBeNull();
    expect(qaStatusOf({ ...base, state: 'New' })).toBeNull();
  });

  /** A live run wins: the card should say "Testing", not "Fix Required", while the agent works. */
  it('prefers Testing over the failed bucket while an agent is running', () => {
    expect(qaStatusOf({ ...base, state: 'Committed', openBugs: 2, qaRunning: true })).toBe(
      'Testing',
    );
  });

  it('shows an open Bug as Fix Required even on a Story ADO still calls Done', () => {
    expect(qaStatusOf({ ...base, openBugs: 1 })).toBe('Failed / Fix Required');
  });

  it('ignores case and padding in the state', () => {
    expect(qaStatusOf({ ...base, state: ' done ' })).toBe('Ready for QA');
  });
});

describe('toPlainText', () => {
  it('strips the HTML Azure DevOps stores descriptions as', () => {
    expect(toPlainText('<div><p>Scaffold the <b>app</b></p><p>Second line</p></div>')).toBe(
      'Scaffold the app Second line',
    );
  });

  it('decodes the entities ADO escapes', () => {
    expect(toPlainText('<p>a &amp; b &lt;tag&gt; &quot;q&quot;&nbsp;end</p>')).toBe(
      'a & b <tag> "q" end',
    );
  });

  it('turns line breaks into spaces rather than running words together', () => {
    expect(toPlainText('one<br>two<br/>three')).toBe('one two three');
  });

  it('returns an empty string for empty input', () => {
    expect(toPlainText('')).toBe('');
  });
});

/**
 * What a Bug's card offers, and what it says when it offers nothing.
 *
 * The contradiction this ends: a Bug QA had retested and passed showed a green "Verified by QA"
 * badge and, directly beneath it, "Fixed — waiting for QA to retest it." Both lines came from the
 * same record. The state alone cannot tell the two apart — a verified Bug still sits in `Done` —
 * so the verified flag has to be part of the decision.
 */
describe('QaBoardService bug fixability', () => {
  const fixability = (state: string, fixRunning: boolean, qaVerified: boolean) =>
    (
      QaBoardService as unknown as {
        fixability: (s: string, f: boolean, v: boolean) => { allowed: boolean; reason?: string };
      }
    ).fixability(state, fixRunning, qaVerified);

  it('offers a fix for a Bug nobody has picked up', () => {
    expect(fixability('New', false, false)).toEqual({ allowed: true });
  });

  it('says nothing more about a Bug QA has verified', () => {
    const verdict = fixability('Done', false, true);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBeUndefined();
  });

  it('still says a fixed Bug awaits retest until QA has verified it', () => {
    expect(fixability('Done', false, false).reason).toMatch(/waiting for QA to retest/i);
  });

  it('reports a fix in flight ahead of anything else', () => {
    expect(fixability('Done', true, true).reason).toMatch(/fixing this Bug now/i);
  });

  /**
   * A reopened Bug is actionable again.
   *
   * `Committed` was read as "a Developer is on it", so the card offered nothing. But a QA agent
   * that rejects a fix reopens the Bug to `Committed` as well — and Bug #628 sat in the In Progress
   * column for ten hours after its run had finished, with no way to act on it. Whether a Developer
   * is really on it is what `fixRunning` knows; the state does not.
   */
  it('offers a fix for a Bug QA reopened, when nothing is running', () => {
    expect(fixability('Committed', false, false)).toEqual({ allowed: true });
  });

  it('refuses while a fix is genuinely in flight, whatever the state says', () => {
    expect(fixability('Committed', true, false).reason).toMatch(/fixing this Bug now/i);
  });

  it('refuses a state it does not recognise, and says so', () => {
    const verdict = fixability('Removed', false, false);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/cannot be dispatched/i);
  });
});

/**
 * QA-leg extension seam (Phase 2.1, ARCHITECTURE.md §4C). The orchestration scheduler drives a QA
 * leg symmetrically to the Developer leg, but QA batch dispatch (`startQaBatch`) is a **Phase 3**
 * capability. This DI token lets the scheduler call into QA **if and when** a provider is bound —
 * with no hard dependency on Phase-3 code. Until Phase 3 registers a real provider, the token is
 * unbound (injected as `undefined` via `@Optional()`) and the QA leg stays inert.
 */
export const QA_BATCH_DISPATCHER = Symbol('QA_BATCH_DISPATCHER');

/** One QA dispatch a batch produced (mirrors the Developer batch's per-Task fan-out). */
export interface QaDispatch {
  /** Empty on a preview — nothing has been dispatched yet. */
  runId: string;
  workItemId: string;
  /** Work-item title, so the UI can say *what* is being tested rather than just an id. */
  title?: string;
  /** `story` = first test of finished development; `bug` = retest of a Developer's fix. */
  kind?: 'story' | 'bug';
}

/**
 * Contract a Phase-3 QA service implements and binds to {@link QA_BATCH_DISPATCHER} to light up the
 * scheduler's QA leg: fan out one QA pod per work item ready for QA (Done Stories + Resolved Bugs),
 * bounded by `maxDispatch`, idempotent via the one-active-run guard.
 */
export interface QaBatchDispatcher {
  startQaBatch(
    projectId: string,
    opts?: { maxDispatch?: number },
  ): Promise<{ dispatched: QaDispatch[] }>;
}

import { Model } from 'mongoose';
import { DraftDocument, DraftKind, DraftStatus } from '../planning/schemas/draft.schema';

/**
 * Presents a list of plans as the Draft model for tests.
 *
 * A project used to have exactly one plan, so specs stubbed `findOne`. Now the orchestrator reads
 * *all* of a project's plans and picks the active one (`draft-repository.ts`), so the stub has to
 * answer `find().sort().exec()`. One helper rather than the same four lines in seven specs — and
 * when the query shape changes again, it changes in one place.
 *
 * Plans are given the fields the selection rule needs, so a spec can pass `{ planMarkdown: '…' }`
 * and get something the rule can actually order.
 */
export function draftModelStub(drafts: unknown[]): Model<DraftDocument> {
  const rows = drafts.map((draft, index) => ({
    kind: DraftKind.Initial,
    seq: index,
    status: DraftStatus.Approved,
    ...(draft as object),
  }));
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as Model<DraftDocument>;
}

/** The common case: one plan, or none. */
export function oneDraftStub(draft: unknown | null): Model<DraftDocument> {
  return draftModelStub(draft === null ? [] : [draft]);
}

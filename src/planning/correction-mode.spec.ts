import { mergeBacklog } from './backlog-merge';
import { BacklogItem, BacklogItemType } from './schemas/draft.schema';

function item(over: Partial<BacklogItem> & Pick<BacklogItem, 'id' | 'type'>): BacklogItem {
  return {
    title: over.id,
    description: '',
    acceptanceCriteria: '',
    parentId: null,
    order: 0,
    priority: 2,
    estimate: null,
    dependsOn: [],
    repo: null,
    sprint: null,
    attachments: [],
    adoId: null,
    ...over,
  } as BacklogItem;
}

/**
 * How `ingestBacklog` decides between merging and replacing.
 *
 * The incident: whether a run was a correction lived in a flag (`backlogCorrection`) separate from
 * what the agent was actually shown (`planFeedback`). Resetting one by hand and not the other left
 * the agent in patch mode while the ingest was in replace mode — and a five-item patch overwrote a
 * sixty-four-item backlog. The decision is now derived from the feedback itself, so the two cannot
 * disagree. This pins the rule that replaced the flag.
 */
describe('correction mode', () => {
  const existing = [
    item({ id: 'epic-1', type: BacklogItemType.Epic }),
    item({ id: 'feat-1', type: BacklogItemType.Feature, parentId: 'epic-1' }),
    item({ id: 'story-1', type: BacklogItemType.Story, parentId: 'feat-1' }),
    item({ id: 'task-1', type: BacklogItemType.Task, parentId: 'story-1' }),
  ];
  const patch = [{ id: 'story-1', acceptanceCriteria: '- It works' } as BacklogItem];

  /** Mirrors the rule in `ingestBacklog`. */
  const correcting = (feedback: string | null, backlog: BacklogItem[]): boolean =>
    Boolean(feedback?.trim()) && backlog.length > 0;

  const ingest = (
    feedback: string | null,
    backlog: BacklogItem[],
    incoming: BacklogItem[],
  ): BacklogItem[] => (correcting(feedback, backlog) ? mergeBacklog(backlog, incoming) : incoming);

  it('merges when the agent was given changes to make', () => {
    const result = ingest('Fix exactly these: ...', existing, patch);
    expect(result).toHaveLength(4);
    expect(result.find((i) => i.id === 'story-1')?.acceptanceCriteria).toBe('- It works');
  });

  /** The exact loss: a patch arriving while the ingest believed it was a fresh draft. */
  it('does not let a patch replace a backlog when changes were requested', () => {
    expect(ingest('Fix exactly these: ...', existing, patch)).toHaveLength(4);
  });

  it('replaces on a fresh draft, which is what a first run should do', () => {
    const fresh = [item({ id: 'new-1', type: BacklogItemType.Epic })];
    expect(ingest(null, existing, fresh)).toEqual(fresh);
  });

  it('treats blank feedback as no feedback', () => {
    const fresh = [item({ id: 'new-1', type: BacklogItemType.Epic })];
    expect(ingest('   ', existing, fresh)).toEqual(fresh);
  });

  it('replaces when there is nothing to merge into, whatever the feedback says', () => {
    const fresh = [item({ id: 'new-1', type: BacklogItemType.Epic })];
    expect(ingest('Fix these', [], fresh)).toEqual(fresh);
  });
});

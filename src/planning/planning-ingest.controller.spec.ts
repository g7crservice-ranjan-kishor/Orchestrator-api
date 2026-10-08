import { PlanningIngestController } from './planning-ingest.controller';
import { PlanningService } from './planning.service';
import { IngestBacklogDto } from './dto/ingest.dto';

/**
 * What survives the journey from the agent's `backlog.json` to the draft.
 *
 * `dependsOn` did not. The parser dropped it, the DTO rejected it, and this controller overwrote
 * whatever arrived with an empty array. So the Scrum Master could be told to declare dependencies,
 * could declare them correctly, and every one of 61 items still reached the draft with none —
 * leaving nothing able to check the ordering the agent had just described. A prompt change alone
 * could never have fixed it, which is the reason this is pinned here rather than in the template.
 */
describe('PlanningIngestController backlog', () => {
  const ingest = async (items: unknown[]) => {
    const planning = { ingestBacklog: jest.fn().mockResolvedValue(undefined) };
    const controller = new PlanningIngestController(planning as unknown as PlanningService);
    await controller.backlog('run-1', { items } as IngestBacklogDto);
    return planning.ingestBacklog.mock.calls[0][1] as Record<string, unknown>[];
  };

  const item = (over: Record<string, unknown> = {}) => ({
    id: 'story-1',
    type: 'story',
    title: 'A story',
    acceptanceCriteria: '- It works',
    ...over,
  });

  it('carries declared dependencies through to the draft', async () => {
    const [stored] = await ingest([item({ dependsOn: ['story-0'] })]);
    expect(stored.dependsOn).toEqual(['story-0']);
  });

  it('keeps an explicit empty list as "depends on nothing"', async () => {
    const [stored] = await ingest([item({ dependsOn: [] })]);
    expect(stored.dependsOn).toEqual([]);
  });

  /**
   * On a correction an absent field means "keep what is there". Writing `[]` here would quietly
   * clear dependencies the agent never touched.
   */
  it('leaves the field absent when the agent did not mention it', async () => {
    const [stored] = await ingest([item()]);
    expect('dependsOn' in stored).toBe(false);
  });

  it('still carries the fields it always did', async () => {
    const [stored] = await ingest([item({ repo: 'ui', sprint: 'Sprint 2', parentId: 'feat-1' })]);
    expect(stored).toMatchObject({
      id: 'story-1',
      title: 'A story',
      repo: 'ui',
      sprint: 'Sprint 2',
      parentId: 'feat-1',
    });
  });
});

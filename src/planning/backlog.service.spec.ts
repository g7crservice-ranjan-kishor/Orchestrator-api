import { BadRequestException } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Model } from 'mongoose';
import { BacklogService } from './backlog.service';
import { BlobService } from '../common/storage/blob.service';
import { Draft, DraftDocument, DraftSchema, BacklogItemType } from './schemas/draft.schema';

describe('BacklogService (in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let model: Model<DraftDocument>;
  let service: BacklogService;
  const projectId = new mongoose.Types.ObjectId().toString();
  const blob = { upload: jest.fn() } as unknown as BlobService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    model = mongoose.model(Draft.name, DraftSchema) as unknown as Model<DraftDocument>;
    service = new BacklogService(model, blob);
  });

  beforeEach(async () => {
    await model.deleteMany({});
    await new model({ projectId: new mongoose.Types.ObjectId(projectId) }).save();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('adds items and assigns sibling order', async () => {
    await service.add(projectId, { type: BacklogItemType.Epic, title: 'Epic A' });
    const draft = await service.add(projectId, { type: BacklogItemType.Epic, title: 'Epic B' });
    expect(draft.backlog).toHaveLength(2);
    expect(draft.backlog[1].order).toBe(1);
  });

  it('rejects adding a child under a non-existent parent', async () => {
    await expect(
      service.add(projectId, { type: BacklogItemType.Feature, title: 'F', parentId: 'ghost' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('updates fields (priority, repo, sprint, deps)', async () => {
    const d1 = await service.add(projectId, { type: BacklogItemType.Task, title: 'T' });
    const id = d1.backlog[0].id;
    const d2 = await service.update(projectId, id, { priority: 1, repo: 'r', sprint: 'Sprint 1' });
    expect(d2.backlog[0]).toMatchObject({ priority: 1, repo: 'r', sprint: 'Sprint 1' });
  });

  it('re-parents children when an item is deleted (no orphans)', async () => {
    const e = (await service.add(projectId, { type: BacklogItemType.Epic, title: 'E' })).backlog[0]
      .id;
    const f = (
      await service.add(projectId, { type: BacklogItemType.Feature, title: 'F', parentId: e })
    ).backlog.find((i) => i.title === 'F')!.id;
    await service.add(projectId, { type: BacklogItemType.Story, title: 'S', parentId: f });
    const after = await service.remove(projectId, f);
    const story = after.backlog.find((i) => i.title === 'S')!;
    expect(story.parentId).toBe(e); // re-parented to the removed feature's parent
  });

  it('rejects a move that would create a cycle', async () => {
    const e = (await service.add(projectId, { type: BacklogItemType.Epic, title: 'E' })).backlog[0]
      .id;
    const f = (
      await service.add(projectId, { type: BacklogItemType.Feature, title: 'F', parentId: e })
    ).backlog.find((i) => i.title === 'F')!.id;
    await expect(service.move(projectId, e, { parentId: f, order: 0 })).rejects.toThrow(
      /under itself or its descendant/,
    );
  });

  it('validate() returns issues for a malformed backlog', async () => {
    await service.add(projectId, { type: BacklogItemType.Task, title: 'orphan task' });
    const issues = await service.validate(projectId);
    expect(issues.length).toBeGreaterThan(0);
  });
});

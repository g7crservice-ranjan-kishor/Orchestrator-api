import { Test } from '@nestjs/testing';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import { AuditService } from './audit.service';
import {
  AuditAction,
  AuditLog,
  AuditLogDocument,
  AuditLogSchema,
} from './schemas/audit-log.schema';

describe('AuditService', () => {
  let mongo: MongoMemoryServer;
  let service: AuditService;
  let model: Model<AuditLogDocument>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }]),
      ],
      providers: [AuditService],
    }).compile();
    service = moduleRef.get(AuditService);
    model = moduleRef.get(getModelToken(AuditLog.name));
  });

  afterAll(async () => {
    await mongo.stop();
  });

  afterEach(async () => {
    // Bypass the append-only Mongoose middleware for test isolation via the native driver.
    await model.collection.deleteMany({});
  });

  it('appends an entry with actor, action, and timestamp', async () => {
    const entry = await service.append({
      actor: { actorId: null, actorEmail: 'admin@x.io' },
      action: AuditAction.DraftApproved,
      entityType: 'draft',
      entityId: 'draft-1',
      projectId: null,
      metadata: { note: 'ok' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe(AuditAction.DraftApproved);
    expect(entry!.actorEmail).toBe('admin@x.io');
    expect((entry as unknown as { createdAt: Date }).createdAt).toBeInstanceOf(Date);
  });

  it('lists entries most-recent-first and filters by project', async () => {
    const p = '507f1f77bcf86cd799439011';
    await service.append({
      actor: { actorId: null, actorEmail: 'system' },
      action: AuditAction.EmPlanningStarted,
      entityType: 'draft',
      entityId: 'd',
      projectId: p,
    });
    await service.append({
      actor: { actorId: null, actorEmail: 'system' },
      action: AuditAction.AdoPushCompleted,
      entityType: 'draft',
      entityId: 'd',
      projectId: p,
    });
    await service.append({
      actor: { actorId: null, actorEmail: 'system' },
      action: AuditAction.ProjectCreated,
      entityType: 'project',
      entityId: 'other',
      projectId: '507f1f77bcf86cd799439099',
    });

    const scoped = await service.list(p);
    expect(scoped).toHaveLength(2);
    expect(scoped[0].action).toBe(AuditAction.AdoPushCompleted); // newest first
    expect(await service.list()).toHaveLength(3);
  });

  it('is append-only: updates are rejected by the schema', async () => {
    await service.append({
      actor: { actorId: null, actorEmail: 'system' },
      action: AuditAction.PlanApproved,
      entityType: 'draft',
      entityId: 'd',
    });
    await expect(
      model.updateOne({ entityId: 'd' }, { $set: { entityId: 'tampered' } }).exec(),
    ).rejects.toThrow(/append-only/);
    await expect(model.deleteMany({}).exec()).rejects.toThrow(/append-only/);
  });
});

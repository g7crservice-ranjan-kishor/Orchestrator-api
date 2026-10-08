import { Test } from '@nestjs/testing';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { AuditService } from '../audit/audit.service';
import {
  BacklogItemType,
  Draft,
  DraftDocument,
  DraftSchema,
} from '../planning/schemas/draft.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { Role } from '../users/schemas/user.schema';

const USER: AuthenticatedUser = {
  userId: '507f1f77bcf86cd799439011',
  email: 'admin@x.io',
  roles: [Role.Administrator],
  sessionId: 's1',
};

function validBacklog() {
  // A complete Epic -> Feature -> Story -> Task chain. Anything less is now a validation error:
  // only a Task is dispatched to an agent, so a branch that never reaches one is work nobody
  // would ever build.
  const item = (id: string, type: BacklogItemType, parentId: string | null, order: number) => ({
    id,
    type,
    title: id.toUpperCase(),
    description: '',
    acceptanceCriteria: type === BacklogItemType.Story ? 'Given/When/Then' : '',
    parentId,
    order,
    priority: 2,
    estimate: null,
    dependsOn: [],
    repo: null,
    sprint: null,
    attachments: [],
    adoId: null,
  });
  return [
    item('e', BacklogItemType.Epic, null, 0),
    item('f', BacklogItemType.Feature, 'e', 1),
    item('s', BacklogItemType.Story, 'f', 2),
    item('t', BacklogItemType.Task, 's', 3),
  ];
}

describe('ApprovalService', () => {
  let mongo: MongoMemoryServer;
  let service: ApprovalService;
  let draftModel: Model<DraftDocument>;
  const append = jest.fn();
  const projectId = new Types.ObjectId();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Draft.name, schema: DraftSchema }]),
      ],
      providers: [ApprovalService, { provide: AuditService, useValue: { append } }],
    }).compile();
    service = moduleRef.get(ApprovalService);
    draftModel = moduleRef.get(getModelToken(Draft.name));
  });

  afterAll(async () => {
    await mongo.stop();
  });

  afterEach(async () => {
    await draftModel.deleteMany({}).exec();
    append.mockReset();
  });

  it('refuses approval until the plan is approved', async () => {
    await new draftModel({ projectId, planApproved: false, backlog: validBacklog() }).save();
    await expect(service.approve(projectId.toString(), USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses approval when the backlog has validation errors', async () => {
    const bad = validBacklog();
    bad[0].title = '   '; // empty title is a validation error
    await new draftModel({ projectId, planApproved: true, backlog: bad }).save();
    await expect(service.approve(projectId.toString(), USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('approves a valid draft and audits it', async () => {
    await new draftModel({ projectId, planApproved: true, backlog: validBacklog() }).save();
    const draft = await service.approve(projectId.toString(), USER);
    expect(draft.approval.approved).toBe(true);
    expect(draft.approval.approvedBy).toBe('admin@x.io');
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('refuses target confirmation before approval', async () => {
    await new draftModel({ projectId, planApproved: true, backlog: validBacklog() }).save();
    await expect(
      service.confirmAdoTarget(
        projectId.toString(),
        { orgUrl: 'o', project: 'p', areaPath: 'a' },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('confirms the target after approval and audits it', async () => {
    await new draftModel({ projectId, planApproved: true, backlog: validBacklog() }).save();
    await service.approve(projectId.toString(), USER);
    append.mockClear();
    const draft = await service.confirmAdoTarget(
      projectId.toString(),
      { orgUrl: 'https://dev.azure.com/o', project: 'p', areaPath: 'p\\a' },
      USER,
    );
    expect(draft.approval.adoTargetConfirmed).toBe(true);
    expect(draft.approval.confirmedTarget?.areaPath).toBe('p\\a');
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('assertWritable throws unless approved and confirmed', async () => {
    const draft = await new draftModel({
      projectId,
      planApproved: true,
      backlog: validBacklog(),
    }).save();
    expect(() => ApprovalService.assertWritable(draft)).toThrow(BadRequestException);

    draft.approval.approved = true;
    expect(() => ApprovalService.assertWritable(draft)).toThrow(/target is not confirmed/);

    draft.approval.adoTargetConfirmed = true;
    draft.approval.confirmedTarget = { orgUrl: 'o', project: 'p', areaPath: 'a' };
    expect(() => ApprovalService.assertWritable(draft)).not.toThrow();
  });
});

import { Test } from '@nestjs/testing';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { AdoPushService, describeCreateFailure } from './ado-push.service';
import { AdoClientService } from './ado-client.service';
import { SprintService } from './sprint.service';
import { KnowledgeBaseService } from '../knowledge/knowledge-base.service';
import { ProjectsService } from '../projects/projects.service';
import { AuditService } from '../audit/audit.service';
import {
  BacklogItemType,
  Draft,
  DraftDocument,
  DraftKind,
  DraftSchema,
  DraftStatus,
} from '../planning/schemas/draft.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { Role } from '../users/schemas/user.schema';
import { adoStub } from '../testing/ado-stub';

const USER: AuthenticatedUser = {
  userId: '507f1f77bcf86cd799439011',
  email: 'admin@x.io',
  roles: [Role.Administrator],
  sessionId: 's1',
};

function backlogItem(id: string, type: BacklogItemType, parentId: string | null, order = 0) {
  return {
    id,
    type,
    title: `${type}-${id}`,
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
  };
}

describe('AdoPushService', () => {
  let mongo: MongoMemoryServer;
  let service: AdoPushService;
  let draftModel: Model<DraftDocument>;
  let createWorkItem: jest.Mock;
  let ensureIteration: jest.Mock;
  const projectId = new Types.ObjectId();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    createWorkItem = jest.fn();
    ensureIteration = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Draft.name, schema: DraftSchema }]),
      ],
      providers: [
        AdoPushService,
        { provide: AdoClientService, useValue: adoStub({ createWorkItem, ensureIteration }) },
        { provide: AuditService, useValue: { append: jest.fn() } },
        // Unconfigured, which is the ordinary case: seeding must not touch a push that has no
        // document storage behind it.
        {
          provide: KnowledgeBaseService,
          useValue: { seedFromPlan: jest.fn().mockResolvedValue(false) },
        },
        // No repositories configured -> the per-Task repo check stays quiet; no iterations
        // readable -> the sprint check degrades rather than blocking.
        { provide: ProjectsService, useValue: { findById: jest.fn().mockResolvedValue(null) } },
        {
          provide: SprintService,
          useValue: {
            listIterations: jest.fn().mockResolvedValue([]),
            resolveTeamName: jest.fn().mockResolvedValue('Proj Team'),
            invalidate: jest.fn(),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(AdoPushService);
    draftModel = moduleRef.get(getModelToken(Draft.name));
  });

  afterAll(async () => {
    await mongo.stop();
  });

  afterEach(async () => {
    await draftModel.deleteMany({}).exec();
    createWorkItem.mockReset();
    ensureIteration.mockClear();
  });

  const seedDraft = (over: Partial<Draft> = {}) =>
    new draftModel({
      projectId,
      status: DraftStatus.Approved,
      planApproved: true,
      backlogApproved: true,
      backlog: [
        backlogItem('e', BacklogItemType.Epic, null),
        backlogItem('f', BacklogItemType.Feature, 'e'),
        backlogItem('s', BacklogItemType.Story, 'f'),
        backlogItem('t', BacklogItemType.Task, 's'),
      ],
      approval: {
        approved: true,
        approvedBy: 'admin@x.io',
        approvedAt: new Date(),
        adoTargetConfirmed: true,
        confirmedTarget: {
          orgUrl: 'https://dev.azure.com/org',
          project: 'Proj',
          areaPath: 'Proj\\A',
        },
        confirmedBy: 'admin@x.io',
        confirmedAt: new Date(),
        pushedToAdo: false,
        pushedAt: null,
      },
      ...over,
    }).save();

  /**
   * A first build asking for a sprint the project does not have.
   *
   * Azure DevOps gives a new project six sprints. A plan with eight phases of work names Sprint 7
   * and Sprint 8 — a perfectly good plan the project has not grown into. The push used to refuse
   * with "fix these in the backlog", asking a person to edit a plan that was right to fit a default
   * nobody chose. The sprints are created instead, under the names the plan used: nothing is moved
   * and nothing is renamed.
   */
  describe('sprints a first build needs but the project does not have', () => {
    const iteration = (name: string) => ({
      name,
      path: `Proj${String.fromCharCode(92)}${name}`,
      timeFrame: 'future',
      startDate: null,
      finishDate: null,
    });

    const sprintsService = () =>
      (service as unknown as { sprints: { listIterations: jest.Mock; resolveTeamName: jest.Mock } })
        .sprints;

    const planNeeding = (sprints: string[]) =>
      seedDraft({
        backlog: [
          { ...backlogItem('s', BacklogItemType.Story, null), sprint: sprints[0] },
          { ...backlogItem('t', BacklogItemType.Task, 's'), sprint: sprints[1] ?? sprints[0] },
        ] as Draft['backlog'],
      });

    beforeEach(() => {
      createWorkItem.mockResolvedValue({ id: 1, url: '' });
    });

    it('creates the sprints the plan names, under those names', async () => {
      const existing = [iteration('Sprint 1'), iteration('Sprint 2')];
      sprintsService()
        .listIterations.mockResolvedValueOnce(existing)
        .mockResolvedValue([...existing, iteration('Sprint 7'), iteration('Sprint 8')]);
      await planNeeding(['Sprint 7', 'Sprint 8']);

      await service.push(projectId.toString(), USER);

      expect(ensureIteration).toHaveBeenCalledWith('Proj', 'Proj Team', 'Sprint 7');
      expect(ensureIteration).toHaveBeenCalledWith('Proj', 'Proj Team', 'Sprint 8');
    });

    it('creates nothing when the project already has them', async () => {
      sprintsService().listIterations.mockResolvedValue([iteration('Sprint 1')]);
      await planNeeding(['Sprint 1']);

      await service.push(projectId.toString(), USER);
      expect(ensureIteration).not.toHaveBeenCalled();
    });

    /** A sprint that was not really created must still stop the push. */
    it('refuses when a sprint could not be created after all', async () => {
      sprintsService().listIterations.mockResolvedValue([iteration('Sprint 1')]);
      await planNeeding(['Sprint 7']);

      await expect(service.push(projectId.toString(), USER)).rejects.toThrow(
        /could not be created/i,
      );
    });

    /** A plan asking for dozens is a planning error, not a schedule — and nothing is created. */
    it('refuses an implausible number rather than creating them', async () => {
      sprintsService().listIterations.mockResolvedValue([iteration('Sprint 1')]);
      await seedDraft({
        backlog: [
          { ...backlogItem('s', BacklogItemType.Story, null), sprint: 'Sprint 2' },
          ...Array.from({ length: 24 }, (_, i) => ({
            ...backlogItem(`t${i}`, BacklogItemType.Task, 's'),
            sprint: `Sprint ${i + 10}`,
          })),
        ] as Draft['backlog'],
      });

      await expect(service.push(projectId.toString(), USER)).rejects.toThrow(
        /far more than a plan/i,
      );
      expect(ensureIteration).not.toHaveBeenCalled();
    });
  });

  /**
   * An enhancement's work must not be created inside a sprint that is already over.
   *
   * The Scrum Master numbers from one whatever it is planning. On this project Sprint 1 and 2 are
   * closed and Sprint 3 is running, so ENH-001's "Sprint 1" has to become Sprint 3 — otherwise the
   * work items exist in Azure DevOps, are absent from the board, and are picked up by nothing.
   */
  describe('scheduling an enhancement', () => {
    const iteration = (name: string, timeFrame: string) => ({
      name,
      path: `Proj${String.fromCharCode(92)}${name}`,
      timeFrame,
      startDate: null,
      finishDate: null,
    });

    const pathOf = (call: unknown[]) => {
      const patch = call[2] as { path: string; value: unknown }[];
      return patch.find((op) => op.path === '/fields/System.IterationPath')?.value;
    };

    beforeEach(() => {
      const sprints = service as unknown as { sprints: { listIterations: jest.Mock } };
      sprints.sprints.listIterations.mockResolvedValue([
        iteration('Sprint 1', 'past'),
        iteration('Sprint 2', 'past'),
        iteration('Sprint 3', 'current'),
        iteration('Sprint 4', 'future'),
      ]);
      createWorkItem.mockResolvedValue({ id: 1, url: '' });
    });

    it('moves a relative Sprint 1 onto the sprint running now', async () => {
      await seedDraft({
        kind: DraftKind.Enhancement,
        seq: 1,
        title: 'Implement Dark Mode',
        backlog: [
          { ...backlogItem('s', BacklogItemType.Story, null), sprint: 'Sprint 1' },
          { ...backlogItem('t', BacklogItemType.Task, 's'), sprint: 'Sprint 2' },
        ] as Draft['backlog'],
      });

      await service.push(projectId.toString(), USER);

      const written = createWorkItem.mock.calls.map(pathOf);
      expect(written).toContain(`Proj${String.fromCharCode(92)}Sprint 3`);
      expect(written).toContain(`Proj${String.fromCharCode(92)}Sprint 4`);
      expect(written).not.toContain(`Proj${String.fromCharCode(92)}Sprint 1`);
    });

    it('starts from the next sprint when the enhancement asked for it', async () => {
      await seedDraft({
        kind: DraftKind.Enhancement,
        seq: 1,
        sprintAnchor: 'next',
        backlog: [
          { ...backlogItem('s', BacklogItemType.Story, null), sprint: 'Sprint 1' },
          { ...backlogItem('t', BacklogItemType.Task, 's'), sprint: 'Sprint 1' },
        ] as Draft['backlog'],
      });

      await service.push(projectId.toString(), USER);
      expect(createWorkItem.mock.calls.map(pathOf)).toContain(
        `Proj${String.fromCharCode(92)}Sprint 4`,
      );
    });

    /** An initial plan is checked against the project's sprints, never silently moved. */
    it('leaves an initial plan’s sprints exactly as written', async () => {
      await seedDraft({
        backlog: [
          { ...backlogItem('s', BacklogItemType.Story, null), sprint: 'Sprint 1' },
          { ...backlogItem('t', BacklogItemType.Task, 's'), sprint: 'Sprint 1' },
        ] as Draft['backlog'],
      });

      await service.push(projectId.toString(), USER);
      expect(createWorkItem.mock.calls.map(pathOf)).toContain(
        `Proj${String.fromCharCode(92)}Sprint 1`,
      );
    });
  });

  it('blocks the push when the draft is not approved (pre-write guard)', async () => {
    await seedDraft({ approval: { approved: false } as Draft['approval'] });
    await expect(service.push(projectId.toString(), USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it('blocks the push when the ADO target is not confirmed', async () => {
    await seedDraft({
      approval: {
        approved: true,
        adoTargetConfirmed: false,
        confirmedTarget: null,
      } as Draft['approval'],
    });
    await expect(service.push(projectId.toString(), USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it('creates the hierarchy parents-first, persists adoId, and marks pushed', async () => {
    await seedDraft();
    let next = 100;
    createWorkItem.mockImplementation(() => Promise.resolve({ id: next++, url: 'u', fields: {} }));

    const result = await service.push(projectId.toString(), USER);

    expect(result.created).toBe(4);
    expect(result.skipped).toBe(0);
    // Epic created before Feature before Story (parents first).
    const titles = createWorkItem.mock.calls.map((c) => c[1]);
    expect(titles).toEqual(['Epic', 'Feature', 'Product Backlog Item', 'Task']);

    const draft = await draftModel.findOne({ projectId }).exec();
    expect(draft!.backlog.every((i) => typeof i.adoId === 'number')).toBe(true);
    expect(draft!.approval.pushedToAdo).toBe(true);
    expect(draft!.approval.pushedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a re-run skips already-created items', async () => {
    await seedDraft();
    let next = 200;
    createWorkItem.mockImplementation(() => Promise.resolve({ id: next++, url: 'u', fields: {} }));
    await service.push(projectId.toString(), USER); // first push creates all 3

    createWorkItem.mockClear();
    const rerun = await service.push(projectId.toString(), USER);
    expect(rerun.created).toBe(0);
    expect(rerun.skipped).toBe(4);
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it('links each child to its created parent by url', async () => {
    await seedDraft();
    let next = 300;
    createWorkItem.mockImplementation(() => Promise.resolve({ id: next++, url: 'u', fields: {} }));
    await service.push(projectId.toString(), USER);

    // The Feature (2nd call) should carry a parent relation pointing at the Epic (id 300).
    const featurePatch = createWorkItem.mock.calls[1][2] as Array<{ path: string; value: unknown }>;
    const rel = featurePatch.find((o) => o.path === '/relations/-');
    expect(rel).toBeDefined();
    expect((rel!.value as { url: string }).url).toContain('/300');
  });
});

/**
 * What a failed create tells the person reading it.
 *
 * Azure DevOps answers "The field 'State' contains the value 'Approved' that is not in the list of
 * supported values" and names neither the work item nor the type. With dozens of creates in one
 * push, that is not enough to act on — and it does not even say whether the value came from us or
 * from the process. A whole round of diagnosis went into guessing it.
 */
describe('describeCreateFailure', () => {
  const patch = (state?: string) =>
    state === undefined
      ? [{ op: 'add', path: '/fields/System.Title', value: 'x' }]
      : [{ op: 'add', path: '/fields/System.State', value: state }];

  const of = (err: unknown, state?: string) =>
    describeCreateFailure(
      err,
      'Product Backlog Item',
      'Persist settings',
      'Task-Manager',
      patch(state) as never,
    );

  it('names the item, the type and the project', () => {
    const message = of(new Error('boom'), 'Approved').message;
    expect(message).toContain('Product Backlog Item');
    expect(message).toContain('Persist settings');
    expect(message).toContain('Task-Manager');
  });

  /** The decisive detail: whether the rejected value was one we sent. */
  it('says which state was sent', () => {
    expect(of(new Error('boom'), 'Approved').message).toContain("State 'Approved'");
  });

  it('says plainly when no state was sent at all', () => {
    expect(of(new Error('boom')).message).toContain('no State field');
  });

  it("keeps Azure DevOps' own explanation", () => {
    expect(of(new Error('not in the list of supported values'), 'Approved').message).toContain(
      'not in the list of supported values',
    );
  });

  /** A token problem must still read as a token problem, not as a bad request. */
  it('keeps the original status', () => {
    const forbidden = new ForbiddenException('token cannot write work items');
    const described = describeCreateFailure(
      forbidden,
      'Task',
      'Scaffold',
      'Proj',
      patch() as never,
    );
    expect((described as HttpException).getStatus()).toBe(403);
  });

  it('copes with something thrown that is not an Error', () => {
    expect(of('plain string').message).toContain('plain string');
  });
});

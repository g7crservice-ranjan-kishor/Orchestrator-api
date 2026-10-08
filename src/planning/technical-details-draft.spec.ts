import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Model } from 'mongoose';
import { PlanningService } from './planning.service';
import { DraftResponseDto } from './dto/draft-response.dto';
import { Draft, DraftDocument, DraftSchema } from './schemas/draft.schema';
import { ProjectsService } from '../projects/projects.service';
import { RequirementsService } from '../requirements/requirements.service';
import { KnowledgeBaseService } from '../knowledge/knowledge-base.service';

/**
 * The technical details as a person actually meets them: by opening the planning page.
 *
 * {@link ./technical-details.spec.ts} proves the reading rules. This proves the thing that makes
 * them visible — nobody presses a "detect" button, because nobody knows one exists. The requirement
 * is written at one moment and the plan is looked at at another, so the *reader* is the one who
 * needs the answer, and resolution happens on read.
 *
 * Against a real in-memory Mongo, because the detail that matters is that what was resolved is
 * still there the second time, rather than being recomputed on every page load.
 */
describe('technical details on a draft (in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let model: Model<DraftDocument>;
  let service: PlanningService;
  let requirements: { listForProject: jest.Mock };
  let projects: { findById: jest.Mock };
  const projectId = new mongoose.Types.ObjectId().toString();

  const REQUIREMENT =
    'Build the application using React, TypeScript, Ant Design, Node.js and MongoDB with the ' +
    'database named EmployeeDB.';

  const build = () =>
    new PlanningService(
      model,
      projects as unknown as ProjectsService,
      requirements as unknown as RequirementsService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        readAll: jest.fn().mockResolvedValue({}),
        existing: jest.fn().mockResolvedValue([]),
      } as never,
      { readAll: jest.fn().mockResolvedValue([]) } as unknown as KnowledgeBaseService,
    );

  const byField = async () => {
    const draft = await service.getOrCreateDraft(projectId);
    return Object.fromEntries(draft.technicalDetails.map((d) => [d.field, d]));
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    model = mongoose.model(Draft.name, DraftSchema) as unknown as Model<DraftDocument>;
  });

  beforeEach(async () => {
    await model.deleteMany({});
    await new model({ projectId: new mongoose.Types.ObjectId(projectId) }).save();
    requirements = {
      listForProject: jest.fn().mockResolvedValue([{ text: REQUIREMENT, createdAt: new Date() }]),
    };
    projects = { findById: jest.fn().mockResolvedValue(null) };
    service = build();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('fills the table the first time the draft is read', async () => {
    const fields = await byField();
    expect(fields.frontend).toMatchObject({ value: 'React', source: 'requirement' });
    expect(fields.database).toMatchObject({ value: 'MongoDB', source: 'requirement' });
    expect(fields.databaseName).toMatchObject({ value: 'EmployeeDB', source: 'requirement' });
  });

  it('marks what the requirement never said as still needing an answer', async () => {
    const fields = await byField();
    expect(fields.auth).toMatchObject({ value: null, source: 'missing' });
  });

  /** Resolution is a one-off: having resolved, it must not read the requirements again. */
  it('does not read the requirements again once the table is filled', async () => {
    await byField();
    await byField();
    expect(requirements.listForProject).toHaveBeenCalledTimes(1);
  });

  it('keeps what it resolved, in the database', async () => {
    await byField();
    const stored = await model.findOne({ projectId: new mongoose.Types.ObjectId(projectId) });
    expect(stored?.technicalDetails).toHaveLength(8);
  });

  /**
   * The rule that makes the table worth editing. A person's answer is the most authoritative thing
   * there is, and a later re-read must not quietly replace it with a detection.
   */
  it('keeps an answer a person gave', async () => {
    await byField();
    await service.setTechnicalDetail(projectId, 'auth', 'Seeded administrator');
    const fields = await byField();
    expect(fields.auth).toMatchObject({ value: 'Seeded administrator', source: 'user' });
  });

  it('leaves the draft readable when there is no requirement yet', async () => {
    requirements.listForProject.mockResolvedValue([]);
    const draft = await service.getOrCreateDraft(projectId);
    expect(draft.technicalDetails).toEqual([]);
  });

  /** A table that is briefly empty is a smaller failure than a planning page that will not open. */
  it('leaves the draft readable when the requirements cannot be read', async () => {
    requirements.listForProject.mockRejectedValue(new Error('mongo down'));
    await expect(service.getOrCreateDraft(projectId)).resolves.toBeTruthy();
  });

  /**
   * What the screen actually receives.
   *
   * `technicalDetails` is a subdocument array, so each entry is a Mongoose document rather than the
   * plain object its type claims. Building the response by spreading one copies its internals and
   * none of its fields, and the panel renders a row with no label, no value and nothing to change —
   * which is what shipped, briefly, and what this test exists to stop. A plain object spreads
   * perfectly well, so only a real draft read back out of Mongo can catch it.
   */
  it('sends every field to the screen, through the response', async () => {
    await byField();
    const draft = await service.getOrCreateDraft(projectId);
    const response = DraftResponseDto.fromDocument(draft);

    expect(response.technicalDetails).toHaveLength(8);
    for (const detail of response.technicalDetails) {
      expect(detail.field).toBeTruthy();
      expect(detail.label).toBeTruthy();
      expect(detail.question).toBeTruthy();
      expect(typeof detail.required).toBe('boolean');
    }

    const frontend = response.technicalDetails.find((d) => d.field === 'frontend');
    expect(frontend?.label).toBe('Frontend');
    expect(frontend?.options).toEqual(expect.arrayContaining(['React', 'Angular']));
  });

  /** A name is not picked from a menu, so it is offered no list. */
  it('offers no options for the database name', async () => {
    await byField();
    const response = DraftResponseDto.fromDocument(await service.getOrCreateDraft(projectId));
    expect(response.technicalDetails.find((d) => d.field === 'databaseName')?.options).toEqual([]);
  });

  /**
   * "SQL" is a kind of database, not a name for one — the mistake the two adjacent rows invited on
   * the first real run. The predicate that already refuses a type when reading one out of a
   * requirement refuses it here too.
   */
  it('refuses a kind of database as the database name', async () => {
    await byField();
    await expect(service.setTechnicalDetail(projectId, 'databaseName', 'SQL')).rejects.toThrow(
      /kind of database, not a name/i,
    );
    await expect(
      service.setTechnicalDetail(projectId, 'databaseName', 'appointment_booking'),
    ).resolves.toBeTruthy();
  });
});

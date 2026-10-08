import { BadRequestException } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Model } from 'mongoose';
import { PlanningService } from './planning.service';
import { Draft, DraftDocument, DraftSchema } from './schemas/draft.schema';
import { AppSecretsService } from '../common/secrets/app-secrets.service';
import { KnowledgeBaseService } from '../knowledge/knowledge-base.service';

/**
 * The application's own runtime credentials (D-029), against a real in-memory Mongo so the central
 * promise — **no secret value ever reaches the database** — is proven against actual persistence
 * rather than a mock that could not have stored one anyway.
 */
describe('required application credentials (in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let model: Model<DraftDocument>;
  let service: PlanningService;
  let appSecrets: {
    set: jest.Mock;
    remove: jest.Mock;
    readAll: jest.Mock;
    existing: jest.Mock;
  };
  const projectId = new mongoose.Types.ObjectId().toString();

  /** Only the collaborators these paths touch; dispatch/ADO are exercised elsewhere. */
  const build = () =>
    new PlanningService(
      model,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      appSecrets as unknown as AppSecretsService,
      // No document storage: these tests are about credentials, and an unconfigured knowledge base
      // is the ordinary case anyway.
      { readAll: jest.fn().mockResolvedValue([]) } as unknown as KnowledgeBaseService,
    );

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    model = mongoose.model(Draft.name, DraftSchema) as unknown as Model<DraftDocument>;
  });

  beforeEach(async () => {
    await model.deleteMany({});
    await new model({ projectId: new mongoose.Types.ObjectId(projectId) }).save();
    appSecrets = {
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      readAll: jest.fn().mockResolvedValue({}),
      // The project holds none of them by default; the cases that care say so explicitly.
      existing: jest.fn().mockResolvedValue([]),
    };
    service = build();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  describe('declaring what the application needs', () => {
    it('records the names and purposes the planning agent declared', async () => {
      const draft = await service.declareRequiredSecrets(projectId, [
        { name: 'DATABASE_URL', description: 'Postgres connection string' },
        { name: 'JWT_SECRET', description: 'Token signing key' },
      ]);
      expect(draft.requiredSecrets.map((s) => s.name)).toEqual(['DATABASE_URL', 'JWT_SECRET']);
      expect(draft.requiredSecrets.every((s) => !s.provided)).toBe(true);
    });

    it('upper-cases names so DATABASE_URL and database_url are one credential', async () => {
      const draft = await service.declareRequiredSecrets(projectId, [{ name: 'database_url' }]);
      expect(draft.requiredSecrets[0].name).toBe('DATABASE_URL');
    });

    it('ignores a name that is not a usable environment variable', async () => {
      const draft = await service.declareRequiredSecrets(projectId, [
        { name: 'DB PASSWORD' },
        { name: 'VALID_NAME' },
      ]);
      expect(draft.requiredSecrets.map((s) => s.name)).toEqual(['VALID_NAME']);
    });

    /** Re-planning must not silently un-provide a credential the user already supplied. */
    it('keeps the provided status when the same credential is re-declared', async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'DATABASE_URL' }]);
      await service.setRequiredSecret(projectId, 'DATABASE_URL', 'postgres://x');
      const draft = await service.declareRequiredSecrets(projectId, [
        { name: 'DATABASE_URL', description: 'revised wording' },
      ]);
      expect(draft.requiredSecrets[0].provided).toBe(true);
      expect(draft.requiredSecrets[0].description).toBe('revised wording');
    });

    /**
     * A credential the project already holds is already provided.
     *
     * The vault is keyed by **project**; `requiredSecrets` is per *plan*. Without this, ENH-001 on
     * the Employee Management System asked again for `DATABASE_URL`, `ADMIN_EMAIL`,
     * `ADMIN_PASSWORD` and `JWT_SECRET` — all four already in the vault, all four shown as
     * "Not set", and the plan unapprovable until someone re-typed a connection string they could
     * not read back.
     */
    it('counts a credential the project already holds as provided', async () => {
      appSecrets.existing.mockResolvedValue(['DATABASE_URL']);
      const draft = await service.declareRequiredSecrets(projectId, [
        { name: 'DATABASE_URL' },
        { name: 'JWT_SECRET' },
      ]);
      const byName = new Map(draft.requiredSecrets.map((s) => [s.name, s]));
      expect(byName.get('DATABASE_URL')?.provided).toBe(true);
      expect(byName.get('DATABASE_URL')?.providedAt).not.toBeNull();
      expect(byName.get('JWT_SECRET')?.provided).toBe(false);
    });

    /**
     * An enhancement must not take the live application's credentials with it.
     *
     * The vault is keyed by **project**; `requiredSecrets` is per *plan*. Comparing a new plan's
     * declaration against that plan alone meant an enhancement declaring one credential would
     * delete the rest from Key Vault — and the rest is what the built, running product reads at
     * startup. ENH-001 declaring only `JWT_SECRET` would have taken the Employee Management
     * System's `DATABASE_URL` with it.
     */
    it('keeps a credential another plan of the project still needs', async () => {
      await service.declareRequiredSecrets(projectId, [
        { name: 'DATABASE_URL' },
        { name: 'JWT_SECRET' },
      ]);
      // A second plan for the same project — an enhancement — that still needs DATABASE_URL.
      await new model({
        projectId: new mongoose.Types.ObjectId(projectId),
        kind: 'enhancement',
        seq: 1,
        requiredSecrets: [{ name: 'DATABASE_URL', provided: true, providedAt: new Date() }],
      }).save();

      await service.declareRequiredSecrets(projectId, [{ name: 'JWT_SECRET' }]);

      expect(appSecrets.remove).not.toHaveBeenCalledWith(projectId, 'DATABASE_URL');
    });

    /**
     * The correction has to happen on **read**, not only when a plan declares its credentials.
     *
     * ENH-001's list was written by a run that recorded every credential as missing. The values had
     * been in Key Vault since the initial build, so the screen showed "Not set" beside four of them
     * and the plan could not be approved until someone re-typed a connection string they cannot
     * read back. Fixing only the declaration path left that row exactly as it was.
     */
    it('corrects a stale "not set" the next time the draft is read', async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'DATABASE_URL' }]);
      expect((await service.getDraftByProject(projectId)).requiredSecrets[0].provided).toBe(false);

      // The project does hold it — the plan was simply written before anyone looked.
      appSecrets.existing.mockResolvedValue(['DATABASE_URL']);

      const draft = await service.getDraftByProject(projectId);
      expect(draft.requiredSecrets[0].provided).toBe(true);
      expect(draft.requiredSecrets[0].providedAt).not.toBeNull();
    });

    /** A plan with everything recorded as provided must not ask the vault on every page load. */
    it('asks the vault nothing when every credential is already provided', async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'DATABASE_URL' }]);
      await service.setRequiredSecret(projectId, 'DATABASE_URL', 'sqlserver://x');
      appSecrets.existing.mockClear();

      await service.getDraftByProject(projectId);
      expect(appSecrets.existing).not.toHaveBeenCalled();
    });

    /** An unreachable vault must not stop a draft being read. */
    it('still returns the draft when the vault cannot be reached', async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'DATABASE_URL' }]);
      appSecrets.existing.mockRejectedValue(new Error('vault unreachable'));

      const draft = await service.getDraftByProject(projectId);
      expect(draft.requiredSecrets[0].provided).toBe(false);
    });

    it('deletes the stored value when a credential is no longer required', async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'OLD_KEY' }]);
      await service.declareRequiredSecrets(projectId, [{ name: 'NEW_KEY' }]);
      expect(appSecrets.remove).toHaveBeenCalledWith(projectId, 'OLD_KEY');
    });
  });

  describe('supplying a value', () => {
    beforeEach(async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'DATABASE_URL' }]);
    });

    it('sends the value to Key Vault and records only that it is set', async () => {
      const draft = await service.setRequiredSecret(projectId, 'DATABASE_URL', 'postgres://secret');
      expect(appSecrets.set).toHaveBeenCalledWith(projectId, 'DATABASE_URL', 'postgres://secret');
      expect(draft.requiredSecrets[0].provided).toBe(true);
      expect(draft.requiredSecrets[0].providedAt).toBeInstanceOf(Date);
    });

    /** The whole point of the design: the database must never be able to leak the value. */
    it('never writes the value into MongoDB', async () => {
      await service.setRequiredSecret(projectId, 'DATABASE_URL', 'super-secret-value');
      const raw = await model.collection.findOne({
        projectId: new mongoose.Types.ObjectId(projectId),
      });
      expect(JSON.stringify(raw)).not.toContain('super-secret-value');
    });

    it('refuses a credential the application never declared', async () => {
      await expect(service.setRequiredSecret(projectId, 'UNKNOWN', 'x')).rejects.toThrow(
        BadRequestException,
      );
      expect(appSecrets.set).not.toHaveBeenCalled();
    });

    it('refuses an empty value rather than marking it provided', async () => {
      await expect(service.setRequiredSecret(projectId, 'DATABASE_URL', '   ')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('the approval gate', () => {
    beforeEach(async () => {
      const draft = await model.findOne({ projectId: new mongoose.Types.ObjectId(projectId) });
      draft!.planMarkdown = '# Plan';
      await draft!.save();
    });

    it('blocks approval while a declared credential is missing, and names it', async () => {
      await service.declareRequiredSecrets(projectId, [
        { name: 'DATABASE_URL' },
        { name: 'JWT_SECRET' },
      ]);
      await service.setRequiredSecret(projectId, 'DATABASE_URL', 'postgres://x');
      await expect(service.approvePlan(projectId)).rejects.toThrow(/JWT_SECRET/);
    });

    it('allows approval once every credential is provided', async () => {
      await service.declareRequiredSecrets(projectId, [{ name: 'DATABASE_URL' }]);
      await service.setRequiredSecret(projectId, 'DATABASE_URL', 'postgres://x');
      const draft = await service.approvePlan(projectId);
      expect(draft.planApproved).toBe(true);
    });

    it('does not gate a project that declared no credentials', async () => {
      const draft = await service.approvePlan(projectId);
      expect(draft.planApproved).toBe(true);
    });
  });
});

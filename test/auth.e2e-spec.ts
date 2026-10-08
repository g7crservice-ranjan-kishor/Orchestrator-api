import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

/**
 * Basic integration verification of the Phase 1 auth flow against an in-memory MongoDB:
 * seed admin → login → authenticated /me → logout → session revoked → public /health.
 * Covers TESTING_STRATEGY.md §3 critical scenario #1 (Auth).
 */
describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let accessToken: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = mongo.getUri();
    process.env.JWT_SIGNING_KEY = 'test-jwt-signing-key';
    process.env.SESSION_SECRET = 'test-session-secret';

    // Import after env is set so config validation sees it.
    const { AppModule } = await import('../src/app.module');
    const { buildValidationPipe } = await import('../src/common/validation/validation-pipe.factory');
    const { AllExceptionsFilter } = await import('../src/common/filters/all-exceptions.filter');
    const { UsersService } = await import('../src/users/users.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    // Seed an administrator.
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@example.com',
      displayName: 'Admin',
      password: 'a-very-strong-password',
    });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('GET /health is public and returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('rejects login with wrong credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('logs in with valid credentials and returns tokens', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: 'a-very-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.email).toBe('admin@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
    accessToken = res.body.accessToken;
  });

  it('rejects /auth/me without a token', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user for an authenticated request', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('admin@example.com');
  });

  it('rejects an unknown property (whitelist validation)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: 'a-very-strong-password', extra: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.correlationId).toBeDefined();
  });

  it('logout revokes the session so the access token stops working', async () => {
    const logout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(logout.status).toBe(204);

    const after = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(after.status).toBe(401);
  });
});

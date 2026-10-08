import { SessionsService } from './sessions.service';
import { PasswordService } from '../password.service';

/** Minimal mock of a Mongoose model exposing only what the service uses. */
function mockModel(overrides: Record<string, unknown> = {}) {
  return {
    findById: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn(),
    ...overrides,
  };
}

describe('SessionsService', () => {
  const passwords = {
    hash: jest.fn().mockResolvedValue('hashed'),
    verify: jest.fn(),
  } as unknown as PasswordService;

  it('findActive returns null for a revoked session', async () => {
    const model = mockModel({
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ revoked: true, expiresAt: new Date(Date.now() + 1e6) }),
      }),
    });
    const service = new SessionsService(model as never, passwords);
    await expect(service.findActive('507f1f77bcf86cd799439011')).resolves.toBeNull();
  });

  it('findActive returns null for an expired session', async () => {
    const model = mockModel({
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ revoked: false, expiresAt: new Date(Date.now() - 1) }),
      }),
    });
    const service = new SessionsService(model as never, passwords);
    await expect(service.findActive('507f1f77bcf86cd799439011')).resolves.toBeNull();
  });

  it('findActive returns null for an invalid id', async () => {
    const service = new SessionsService(mockModel() as never, passwords);
    await expect(service.findActive('not-an-objectid')).resolves.toBeNull();
  });

  it('validateAndRotate returns null when the refresh token does not match', async () => {
    (passwords.verify as jest.Mock).mockResolvedValueOnce(false);
    const session = {
      revoked: false,
      expiresAt: new Date(Date.now() + 1e6),
      refreshTokenHash: 'h',
    };
    const model = mockModel({
      findById: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(session) }),
    });
    const service = new SessionsService(model as never, passwords);
    await expect(
      service.validateAndRotate('507f1f77bcf86cd799439011', 'wrong', 1000),
    ).resolves.toBeNull();
  });

  it('validateAndRotate rotates the token on a match', async () => {
    (passwords.verify as jest.Mock).mockResolvedValueOnce(true);
    const save = jest.fn().mockResolvedValue(undefined);
    const session = {
      revoked: false,
      expiresAt: new Date(Date.now() + 1e6),
      refreshTokenHash: 'old',
      lastSeenAt: new Date(),
      save,
    };
    const model = mockModel({
      findById: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(session) }),
    });
    const service = new SessionsService(model as never, passwords);
    const result = await service.validateAndRotate('507f1f77bcf86cd799439011', 'right', 1000);
    expect(result).not.toBeNull();
    expect(result?.refreshToken).toBeDefined();
    expect(session.refreshTokenHash).toBe('hashed');
    expect(save).toHaveBeenCalled();
  });
});

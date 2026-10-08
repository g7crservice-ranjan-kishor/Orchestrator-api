import { BadRequestException } from '@nestjs/common';
import { PasswordResetService } from './password-reset.service';
import { UsersService } from '../../users/users.service';
import { PasswordService } from '../password.service';
import { SessionsService } from '../sessions/sessions.service';

/** Builds a constructable mock Mongoose model whose instances expose save(), plus findOne(). */
function buildModel(findOneResult: unknown) {
  const saved: unknown[] = [];
  const ModelCtor = jest.fn().mockImplementation((doc: Record<string, unknown>) => ({
    ...doc,
    save: jest.fn().mockResolvedValue(undefined),
  })) as unknown as {
    (doc: Record<string, unknown>): unknown;
    findOne: jest.Mock;
    saved: unknown[];
  };
  (ModelCtor as unknown as { findOne: jest.Mock }).findOne = jest
    .fn()
    .mockReturnValue({ exec: jest.fn().mockResolvedValue(findOneResult) });
  (ModelCtor as unknown as { saved: unknown[] }).saved = saved;
  return ModelCtor;
}

describe('PasswordResetService', () => {
  const passwords = {
    hash: jest.fn().mockResolvedValue('hashed'),
    verify: jest.fn(),
  } as unknown as PasswordService;

  it('request returns null for an unknown email (enumeration-safe)', async () => {
    const users = { findByEmail: jest.fn().mockResolvedValue(null) } as unknown as UsersService;
    const service = new PasswordResetService(
      buildModel(null) as never,
      users,
      passwords,
      {} as SessionsService,
    );
    await expect(service.request('nobody@example.com')).resolves.toBeNull();
  });

  it('request issues a tokenId.secret token for a known user', async () => {
    const users = {
      findByEmail: jest.fn().mockResolvedValue({ _id: 'u1' }),
    } as unknown as UsersService;
    const service = new PasswordResetService(
      buildModel(null) as never,
      users,
      passwords,
      {} as SessionsService,
    );
    const token = await service.request('admin@example.com');
    expect(token).toMatch(/^[0-9a-f-]+\.[A-Za-z0-9_-]+$/);
  });

  it('confirm rejects a malformed token', async () => {
    const service = new PasswordResetService(
      buildModel(null) as never,
      {} as UsersService,
      passwords,
      {} as SessionsService,
    );
    await expect(service.confirm('garbage', 'new-strong-password')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('confirm rejects an expired token', async () => {
    const record = {
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() - 1),
      secretHash: 'h',
    };
    const service = new PasswordResetService(
      buildModel(record) as never,
      {} as UsersService,
      passwords,
      {} as SessionsService,
    );
    await expect(service.confirm('tid.secret', 'new-strong-password')).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('confirm sets the password and revokes sessions on a valid token', async () => {
    (passwords.verify as jest.Mock).mockResolvedValueOnce(true);
    const record = {
      userId: { toString: () => 'u1' },
      usedAt: null,
      expiresAt: new Date(Date.now() + 1e6),
      secretHash: 'h',
      save: jest.fn().mockResolvedValue(undefined),
    };
    const users = { update: jest.fn().mockResolvedValue(undefined) } as unknown as UsersService;
    const sessions = {
      listForUser: jest.fn().mockResolvedValue([{ id: 's1', revoked: false }]),
      revoke: jest.fn().mockResolvedValue(undefined),
    } as unknown as SessionsService;
    const service = new PasswordResetService(
      buildModel(record) as never,
      users,
      passwords,
      sessions,
    );

    await service.confirm('tid.secret', 'new-strong-password');
    expect(record.usedAt).not.toBeNull();
    expect(users.update).toHaveBeenCalledWith('u1', { password: 'new-strong-password' });
    expect(sessions.revoke).toHaveBeenCalledWith('s1');
  });
});

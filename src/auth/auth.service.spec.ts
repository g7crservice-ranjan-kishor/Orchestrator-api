import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { SessionsService } from './sessions/sessions.service';
import { AppConfigService } from '../common/config/app-config.service';

describe('AuthService.login', () => {
  const config = { sessionTtlSeconds: 1000 } as AppConfigService;

  const makeService = (over: {
    user?: unknown;
    verify?: boolean;
  }): {
    service: AuthService;
    users: jest.Mocked<
      Pick<UsersService, 'findByEmail' | 'registerFailedLogin' | 'registerSuccessfulLogin'>
    >;
    sessions: { create: jest.Mock };
  } => {
    const users = {
      findByEmail: jest.fn().mockResolvedValue(over.user ?? null),
      registerFailedLogin: jest.fn().mockResolvedValue(undefined),
      registerSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<
      Pick<UsersService, 'findByEmail' | 'registerFailedLogin' | 'registerSuccessfulLogin'>
    >;
    const passwords = {
      verify: jest.fn().mockResolvedValue(over.verify ?? false),
    } as unknown as PasswordService;
    const tokens = {
      issueAccessToken: jest.fn().mockResolvedValue('access.jwt'),
      accessTokenTtlSeconds: 900,
    } as unknown as TokenService;
    const sessions = {
      create: jest.fn().mockResolvedValue({
        session: { id: 'sess-1' },
        refreshToken: 'refresh-raw',
      }),
    };
    const service = new AuthService(
      users as unknown as UsersService,
      passwords,
      tokens,
      sessions as unknown as SessionsService,
      config,
    );
    return { service, users, sessions };
  };

  const activeUser = {
    id: 'u1',
    email: 'admin@example.com',
    disabled: false,
    lockedUntil: null,
    passwordHash: 'hash',
    roles: ['administrator'],
  };

  it('returns tokens on valid credentials and clears failed-login state', async () => {
    const { service, users, sessions } = makeService({ user: activeUser, verify: true });
    const result = await service.login('admin@example.com', 'pw', {});
    expect(result.accessToken).toBe('access.jwt');
    expect(result.sessionId).toBe('sess-1');
    expect(result.refreshToken).toBe('refresh-raw');
    expect(sessions.create).toHaveBeenCalled();
    expect(users.registerSuccessfulLogin).toHaveBeenCalledWith('u1');
  });

  it('throws and records a failed attempt on wrong password', async () => {
    const { service, users } = makeService({ user: activeUser, verify: false });
    await expect(service.login('admin@example.com', 'bad', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(users.registerFailedLogin).toHaveBeenCalled();
  });

  it('throws for an unknown user without leaking which factor failed', async () => {
    const { service } = makeService({ user: null });
    await expect(service.login('nobody@example.com', 'pw', {})).rejects.toThrow(
      'Invalid credentials.',
    );
  });

  it('throws for a disabled account', async () => {
    const { service } = makeService({ user: { ...activeUser, disabled: true }, verify: true });
    await expect(service.login('admin@example.com', 'pw', {})).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws for a locked account', async () => {
    const locked = { ...activeUser, lockedUntil: new Date(Date.now() + 60000) };
    const { service } = makeService({ user: locked, verify: true });
    await expect(service.login('admin@example.com', 'pw', {})).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

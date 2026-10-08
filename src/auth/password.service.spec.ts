import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes to an argon2id-encoded string that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('s3cure-p@ssw0rd!');
    await expect(service.verify(hash, 's3cure-p@ssw0rd!')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('s3cure-p@ssw0rd!');
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    await expect(service.verify('not-a-hash', 'whatever')).resolves.toBe(false);
  });

  it('produces different hashes for the same input (random salt)', async () => {
    const a = await service.hash('same-input-value');
    const b = await service.hash('same-input-value');
    expect(a).not.toBe(b);
  });
});

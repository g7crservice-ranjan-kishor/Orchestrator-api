import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing using argon2id (the locked auth choice — see engagement decisions). Parameters
 * follow current OWASP guidance for argon2id. Hashing is memory-hard and salted internally by the
 * library; verification is constant-time. Plaintext passwords never leave this service.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  };

  /** Hashes a plaintext password, returning an encoded argon2id hash (includes salt + params). */
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  /** Verifies a plaintext password against a stored hash. Returns false on any error. */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }
}

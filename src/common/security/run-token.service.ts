import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfigService } from '../config/app-config.service';
import { SecretsService } from '../secrets/secrets.service';

/**
 * Issues and verifies short-lived, per-run bearer tokens for the privileged Runner/events API
 * (DEVELOPMENT_GUIDELINES.md §4). A token is `base64url(runId.expEpochMs).hmacSha256` signed with
 * the server session secret, so the backend can verify an event POST without any shared state
 * beyond the signing key. Tokens are bound to a single `runId` and expire, limiting blast radius
 * if one leaks. The token is injected into the Job as `RUN_TOKEN` by the jobs module.
 */
@Injectable()
export class RunTokenService {
  private signingKey?: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly secrets: SecretsService,
  ) {}

  private async key(): Promise<string> {
    if (!this.signingKey) {
      this.signingKey = await this.secrets.require('SESSION_SECRET');
    }
    return this.signingKey;
  }

  private sign(payload: string, key: string): string {
    return createHmac('sha256', key).update(payload).digest('base64url');
  }

  /** Issues a token for `runId`, valid for `ttlMs` (default 2× the run lease TTL). */
  async issue(
    runId: string,
    ttlMs = this.config.runLeaseTtlMs * 2,
    nowMs = Date.now(),
  ): Promise<string> {
    const key = await this.key();
    const exp = nowMs + ttlMs;
    const payload = Buffer.from(`${runId}.${exp}`).toString('base64url');
    return `${payload}.${this.sign(payload, key)}`;
  }

  /**
   * Verifies that `token` is a valid, unexpired token for `runId`. Uses a constant-time comparison
   * on the signature to avoid timing oracles.
   */
  async verify(runId: string, token: string | undefined, nowMs = Date.now()): Promise<boolean> {
    if (!token) {
      return false;
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      return false;
    }
    const [payload, signature] = parts;
    const key = await this.key();
    const expected = this.sign(payload, key);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const [tokenRunId, expStr] = decoded.split('.');
    const exp = Number(expStr);
    if (tokenRunId !== runId || !Number.isFinite(exp) || exp < nowMs) {
      return false;
    }
    return true;
  }
}

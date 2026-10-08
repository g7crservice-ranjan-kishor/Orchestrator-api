import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { RunTokenService } from './run-token.service';

/** Header the Agent Runner presents on every event POST. */
export const RUN_TOKEN_HEADER = 'x-run-token';

/**
 * Guards the privileged Runner/events API: validates the per-run `x-run-token` header against the
 * `runId` in the route. Combined with the private-network NetworkPolicy (k8s/networkpolicy.yaml)
 * and backend-only pod creation, this enforces that only a live run pod can post its own events
 * (DEVELOPMENT_GUIDELINES.md §4). The token never authenticates a user session.
 */
@Injectable()
export class RunTokenGuard implements CanActivate {
  constructor(private readonly runTokens: RunTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const first = (v: string | string[] | undefined): string | undefined =>
      Array.isArray(v) ? v[0] : v;
    const runId = first(request.params?.id) ?? first(request.params?.runId);
    const token = first(request.headers[RUN_TOKEN_HEADER]);

    if (!runId || !(await this.runTokens.verify(runId, token))) {
      throw new UnauthorizedException('Invalid or missing run token.');
    }
    return true;
  }
}

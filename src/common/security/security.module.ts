import { Global, Module } from '@nestjs/common';
import { RunTokenService } from './run-token.service';
import { RunTokenGuard } from './run-token.guard';

/** Cross-cutting security primitives for the privileged Runner API. */
@Global()
@Module({
  providers: [RunTokenService, RunTokenGuard],
  exports: [RunTokenService, RunTokenGuard],
})
export class SecurityModule {}

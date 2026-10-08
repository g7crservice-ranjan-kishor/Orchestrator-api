import { AdoClientService } from '../ado/ado-client.service';

/**
 * Presents a plain object as an {@link AdoClientService} for tests.
 *
 * Production code reaches Azure DevOps through `ado.for(projectId)`, which returns a client bound to
 * that project's own credentials. A stub therefore has to answer `for` — and it answers with itself,
 * so the same assertions hold whether the call site under test binds a project or not. Without this,
 * a spec would have to know which call sites are bound, which is exactly the detail it should not
 * care about.
 */
export function adoStub<T extends object>(stub: T): AdoClientService {
  return Object.assign(stub, { for: () => stub }) as unknown as AdoClientService;
}

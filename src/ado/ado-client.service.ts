import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { AdoRelation } from '../development/story-links';
import { SecretsService } from '../common/secrets/secrets.service';
import { AppSecretsService } from '../common/secrets/app-secrets.service';
import { ProjectsService } from '../projects/projects.service';
import { AdoWorkItem, JsonPatchOperation } from './ado.types';

const API_VERSION = '7.0';

/** Creating a project is asynchronous; 60 x 2s gives it two minutes to finish. */
const PROJECT_CREATE_POLLS = 60;
const PROJECT_CREATE_POLL_MS = 2000;

/** A team's iteration with Azure DevOps' own calendar classification and its configured dates. */
/** A node of the area (or iteration) tree, as Azure DevOps returns it. */
export interface AdoClassificationNode {
  name: string;
  children?: AdoClassificationNode[];
}

/** A Git repository in an Azure DevOps project. `remoteUrl` is what a pod clones. */
export interface AdoRepository {
  id: string;
  name: string;
  remoteUrl: string;
}

export interface AdoIteration {
  name: string;
  /** Full iteration path as ADO reports it, e.g. `NQAI-DevAutomation\Sprint 2`. */
  path: string;
  /** `past` | `current` | `future` | `unknown` — derived by ADO from the dates below. */
  timeFrame: string;
  startDate: string | null;
  finishDate: string | null;
}

/**
 * Thin Azure DevOps REST client. Authenticates with a PAT (from Key Vault / env via
 * {@link SecretsService}) using Basic auth (`:{PAT}` base64-encoded — the ADO convention). The
 * org base URL comes from config. All writes go through here so ADO access is centralised and the
 * PAT is never logged.
 */
/**
 * The human-readable part of an Azure DevOps error body.
 *
 * Azure DevOps answers with `{ "message": "TF401347: Invalid tree name ...", ... }`, and that
 * sentence is the entire diagnosis. Reporting only the status code — which is what this used to do
 * — turned a fixable problem ("that area path does not exist") into "Azure DevOps request failed
 * (400)", which tells the person nothing they can act on and leaves them with no next step.
 */
export function adoErrorMessage(body: string): string | null {
  const text = (body ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON — an HTML sign-in page or a proxy error. The first line is the best we have.
  }
  const firstLine = text.split('\n')[0].trim();
  // An HTML body says nothing useful to a reader; better to say nothing than to paste markup.
  if (!firstLine || firstLine.startsWith('<')) return null;
  return firstLine.slice(0, 400);
}

/**
 * The exception a failed Azure DevOps call should raise.
 *
 * The status matters as much as the message: a 400 caused by our own payload was being reported as
 * `503 Service Unavailable`, which says "Azure DevOps is down, try later" about a request that
 * will fail identically every time. Each case here names what the reader can actually do.
 */
export function adoFailure(status: number, body: string): HttpException {
  const reason = adoErrorMessage(body);
  const because = reason ? ` ${reason}` : '';
  switch (status) {
    case 400:
      return new BadRequestException(`Azure DevOps rejected this request.${because}`);
    case 401:
      return new UnauthorizedException(
        `Azure DevOps did not accept the token for this project. It may have expired.${because}`,
      );
    case 403:
      return new ForbiddenException(
        'The token was accepted but is not allowed to do this. Check it grants Work Items ' +
          `(read & write), Code (read & write) and Project and Team (read).${because}`,
      );
    case 404:
      return new NotFoundException(
        `Azure DevOps has no such project, area path, or work item.${because}`,
      );
    default:
      return new ServiceUnavailableException(`Azure DevOps request failed (${status}).${because}`);
  }
}

@Injectable()
export class AdoClientService {
  private readonly logger = new Logger(AdoClientService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly secrets: SecretsService,
    private readonly appSecrets: AppSecretsService,
    private readonly projects: ProjectsService,
  ) {}

  /** Set when this instance speaks for one project rather than the platform. */
  private binding?: { projectId: string };

  /**
   * Credentials handed in directly, before any project exists to read them from.
   *
   * Project creation has to prove the token works *before* it is stored, otherwise the first sign
   * that a token is wrong is a run failing hours later with an opaque 401.
   */
  private explicit?: { orgUrl: string; pat: string };
  /** Resolved once per bound client, so a service that reuses one makes a single lookup. */
  private resolvedOrgUrl?: string;

  /**
   * A client that uses **this project's own** Azure DevOps credentials.
   *
   * Every method funnels through `request()`, so binding the credentials to a cloned instance
   * changes who the orchestrator is without touching a single call signature. A project with no
   * token of its own falls back to the platform `ADO_PAT` — which is what every project used before
   * this existed, so nothing already configured stops working.
   */
  /**
   * A client that speaks with the given organization and token, bound to no project.
   *
   * Used only to check credentials and list what they can see while a project is being set up.
   */
  withCredentials(orgUrl: string, pat: string): AdoClientService {
    const bound = Object.create(this) as AdoClientService;
    bound.explicit = { orgUrl: orgUrl.trim().replace(/\/+$/, ''), pat: pat.trim() };
    return bound;
  }

  for(projectId: string | null | undefined): AdoClientService {
    if (!projectId) return this; // nothing to bind to; the platform credentials stand
    const bound = Object.create(this) as AdoClientService;
    bound.binding = { projectId };
    return bound;
  }

  /** The bound project's token, or null when it has none and the platform's should be used. */
  private async boundPat(): Promise<string | null> {
    if (!this.binding) return null;
    try {
      const found = await this.appSecrets.readAll(this.binding.projectId, ['ADO_PAT']);
      return found.ADO_PAT?.trim() || null;
    } catch (err) {
      // A vault that cannot be read must not take down a project that also has the platform token.
      this.logger.warn(
        `Could not read the project's Azure DevOps token: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async authHeader(): Promise<string> {
    if (this.explicit) {
      return `Basic ${Buffer.from(`:${this.explicit.pat}`).toString('base64')}`;
    }
    const pat = (await this.boundPat()) ?? (await this.secrets.get('ADO_PAT'));
    if (!pat) {
      throw new ServiceUnavailableException(
        'No Azure DevOps token is configured for this project, and no platform token is set.',
      );
    }
    return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }

  /**
   * The organization this client speaks to: the bound project's own, else the platform's.
   *
   * Resolved here rather than passed in by every caller — thirty-two call sites would each have had
   * to load the project first, and one that forgot would quietly talk to the wrong organization.
   */
  private async orgUrl(): Promise<string> {
    if (this.explicit) return this.explicit.orgUrl;
    if (this.resolvedOrgUrl) return this.resolvedOrgUrl;
    let org = this.config.adoOrgUrl;
    if (this.binding) {
      const project = await this.projects.findById(this.binding.projectId).catch(() => null);
      org = project?.adoTarget?.orgUrl?.trim() || org;
    }
    if (!org) {
      throw new ServiceUnavailableException('No Azure DevOps organization URL is configured.');
    }
    this.resolvedOrgUrl = org.replace(/\/+$/, '');
    return this.resolvedOrgUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    const url = `${await this.orgUrl()}/${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: await this.authHeader(),
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`ADO ${method} ${path} failed: ${res.status} ${detail.slice(0, 500)}`);
      throw adoFailure(res.status, detail);
    }
    return (await res.json()) as T;
  }

  /** Creates a work item of `type` in `project` from a JSON-Patch document. */
  createWorkItem(project: string, type: string, patch: JsonPatchOperation[]): Promise<AdoWorkItem> {
    const path = `${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(
      type,
    )}?api-version=${API_VERSION}`;
    return this.request<AdoWorkItem>('POST', path, patch, 'application/json-patch+json');
  }

  /** Applies a JSON-Patch update to one work item (state transitions, comments, field edits). */
  updateWorkItem(id: number, patch: JsonPatchOperation[]): Promise<AdoWorkItem> {
    const path = `_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
    return this.request<AdoWorkItem>('PATCH', path, patch, 'application/json-patch+json');
  }

  /**
   * Transitions a work item to `state`, attaching a short note to its history — every status change
   * carries a descriptive comment (WORKFLOW.md §5). `extraFields` satisfies process rules that make
   * other fields required on a transition (e.g. Assigned To must be non-empty to start work); they
   * must be applied in the **same** patch, or ADO rejects the state change.
   */
  setWorkItemState(
    id: number,
    state: string,
    comment: string,
    extraFields: Record<string, unknown> = {},
  ): Promise<AdoWorkItem> {
    return this.updateWorkItem(id, [
      { op: 'add', path: '/fields/System.State', value: state },
      { op: 'add', path: '/fields/System.History', value: comment },
      ...Object.entries(extraFields).map(([field, value]) => ({
        op: 'add' as const,
        path: `/fields/${field}`,
        value,
      })),
    ]);
  }

  /**
   * The process templates this organization offers (Agile, Scrum, CMMI, and any inherited ones).
   *
   * The orchestrator's whole state vocabulary — `To Do`, `In Progress`, `Approved`, `Committed` —
   * is Scrum's. A project created on any other process has different state names, so the work
   * items can be created and then never move. Which processes exist is per organization, so the
   * id cannot be hardcoded.
   */
  async listProcesses(): Promise<{ id: string; name: string }[]> {
    const res = await this.request<{ value?: { id: string; name: string }[] }>(
      'GET',
      `_apis/process/processes?api-version=${API_VERSION}`,
    );
    return (res.value ?? []).map((p) => ({ id: p.id, name: p.name }));
  }

  /**
   * Creates an Azure DevOps project and waits for it to be ready.
   *
   * Creation is asynchronous: Azure DevOps answers immediately with an operation to poll, and the
   * project does not exist until that operation succeeds. Returning before then would hand back a
   * project name that nothing else can use yet — the area path, the repositories and the first
   * push would all fail against a project still being built.
   */
  async createProject(name: string, description: string, processTemplateId: string): Promise<void> {
    const operation = await this.request<{ id: string }>(
      'POST',
      `_apis/projects?api-version=${API_VERSION}`,
      {
        name,
        description,
        capabilities: {
          versioncontrol: { sourceControlType: 'Git' },
          processTemplate: { templateTypeId: processTemplateId },
        },
      },
    );
    await this.awaitOperation(operation.id, name);
  }

  /** Polls an Azure DevOps operation until it succeeds, or explains why it did not. */
  private async awaitOperation(operationId: string, what: string): Promise<void> {
    for (let attempt = 0; attempt < PROJECT_CREATE_POLLS; attempt += 1) {
      const op = await this.request<{ status: string; resultMessage?: string }>(
        'GET',
        `_apis/operations/${encodeURIComponent(operationId)}?api-version=${API_VERSION}`,
      );
      if (op.status === 'succeeded') return;
      if (op.status === 'failed' || op.status === 'cancelled') {
        throw new ServiceUnavailableException(
          `Azure DevOps could not create '${what}': ${op.resultMessage ?? op.status}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PROJECT_CREATE_POLL_MS));
    }
    throw new ServiceUnavailableException(
      `Azure DevOps is still creating '${what}' after ` +
        `${(PROJECT_CREATE_POLLS * PROJECT_CREATE_POLL_MS) / 1000}s. It may yet appear; check the ` +
        'organization before trying again, so a second attempt does not collide with the first.',
    );
  }

  /**
   * Every project the token can see in the organization.
   *
   * Doubles as the credential check during setup: a token that cannot list projects cannot do
   * anything else either, and finding that out here is far cheaper than finding it out mid-run.
   */
  async listProjects(): Promise<{ id: string; name: string }[]> {
    const res = await this.request<{ value?: { id: string; name: string }[] }>(
      'GET',
      `_apis/projects?api-version=${API_VERSION}`,
    );
    return (res.value ?? []).map((p) => ({ id: p.id, name: p.name }));
  }

  /**
   * The area paths that already exist in `project`, as full `Project\\Parent\\Child` paths.
   *
   * Area paths are how the orchestrator scopes a project's work items, so one that does not exist
   * means every query silently returns nothing — a project that looks configured and finds no work.
   * Listing them lets the caller pick a real one instead of typing a path that only looks right.
   */
  async listAreaPaths(project: string): Promise<string[]> {
    const path =
      `${encodeURIComponent(project)}/_apis/wit/classificationnodes/areas` +
      `?$depth=10&api-version=${API_VERSION}`;
    const root = await this.request<AdoClassificationNode>('GET', path);
    const paths: string[] = [];
    const walk = (node: AdoClassificationNode, prefix: string): void => {
      const full = prefix ? `${prefix}\\${node.name}` : node.name;
      paths.push(full);
      for (const child of node.children ?? []) walk(child, full);
    };
    walk(root, '');
    return paths;
  }

  /**
   * Makes sure `areaPath` exists, creating any missing levels, and returns the full path.
   *
   * `areaPath` may be given with or without the project prefix (`Proj\\Team A` or `Team A`).
   * Creating an area that is already there is not an error — Azure DevOps answers 409, which this
   * treats as success, so two projects configured at the same moment cannot fail each other.
   */
  async ensureAreaPath(project: string, areaPath: string): Promise<string> {
    const segments = areaPath
      .split('\\')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) throw new ServiceUnavailableException('No area path was given.');
    // The first segment is the project itself when present; the rest are nodes under its root.
    const relative = segments[0] === project ? segments.slice(1) : segments;
    let parent = '';
    for (const name of relative) {
      const path =
        `${encodeURIComponent(project)}/_apis/wit/classificationnodes/areas` +
        `${parent ? `/${parent.split('\\').map(encodeURIComponent).join('/')}` : ''}` +
        `?api-version=${API_VERSION}`;
      try {
        await this.request<AdoClassificationNode>('POST', path, { name });
      } catch (err) {
        // Already there is the outcome we wanted; anything else is a real failure.
        if (!/\(409\)/.test((err as Error).message)) throw err;
      }
      parent = parent ? `${parent}\\${name}` : name;
    }
    return [project, ...relative].join('\\');
  }

  /** The repositories in `project`, newest API shape, with the clone URL the pods use. */
  async listRepositories(project: string): Promise<AdoRepository[]> {
    const path = `${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_VERSION}`;
    const res = await this.request<{ value?: AdoRepository[] }>('GET', path);
    return (res.value ?? []).map((r) => ({ id: r.id, name: r.name, remoteUrl: r.remoteUrl }));
  }

  /**
   * The repository called `name`, created if it does not exist yet.
   *
   * A project's repositories are part of what the orchestrator provisions: asking someone to go and
   * create them by hand, then paste clone URLs back, is the step that produced every wrong URL so
   * far. Returning the existing one when it is already there keeps configuration repeatable.
   */
  async ensureRepository(project: string, name: string): Promise<AdoRepository> {
    const existing = (await this.listRepositories(project)).find(
      (r) => r.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (existing) return existing;
    const path = `${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_VERSION}`;
    const created = await this.request<AdoRepository>('POST', path, { name: name.trim() });
    return { id: created.id, name: created.name, remoteUrl: created.remoteUrl };
  }

  /**
   * The states a work item type actually has in this project, with their workflow category.
   *
   * Processes disagree about state names — Scrum's backlog items go New → Approved → Committed →
   * Done, Agile's go New → Active → Resolved → Closed, and an inherited process can rename or
   * remove any of them. Writing a name we assumed produced
   * "The field 'State' contains the value 'Approved' that is not in the list of supported values",
   * which is a guess failing, not a configuration mistake. The categories (`Proposed`,
   * `InProgress`, `Resolved`, `Completed`, `Removed`) are the part every process shares.
   */
  async listWorkItemTypeStates(
    project: string,
    type: string,
  ): Promise<{ name: string; category: string }[]> {
    // This endpoint is preview-gated: asking for it at the plain API version answers 404, which
    // this class turns into "could not read the states" and then into a Story created with no
    // state at all. The suffix is the difference between the feature working and silently not.
    const path =
      `${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}` +
      `/states?api-version=${API_VERSION}-preview.1`;
    const res = await this.request<{ value?: { name: string; category: string }[] }>('GET', path);
    return (res.value ?? []).map((s) => ({ name: s.name, category: s.category }));
  }

  /** Teams in a project. The first entry is the project's default team. */
  async listTeams(project: string): Promise<{ id: string; name: string }[]> {
    const path = `_apis/projects/${encodeURIComponent(project)}/teams?api-version=${API_VERSION}`;
    const res = await this.request<{ value?: { id: string; name: string }[] }>('GET', path);
    return res.value ?? [];
  }

  /**
   * A team's iterations with **Azure DevOps' own** past/current/future classification
   * (`attributes.timeFrame`). This is the authoritative source for "which sprint is active" — the
   * orchestrator never hardcodes sprint names or infers them from dates.
   */
  async listTeamIterations(project: string, team: string): Promise<AdoIteration[]> {
    const path =
      `${encodeURIComponent(project)}/${encodeURIComponent(team)}` +
      `/_apis/work/teamsettings/iterations?api-version=${API_VERSION}`;
    const res = await this.request<{
      value?: {
        name: string;
        path: string;
        attributes?: { timeFrame?: string; startDate?: string | null; finishDate?: string | null };
      }[];
    }>('GET', path);
    return (res.value ?? []).map((i) => ({
      name: i.name,
      path: i.path,
      timeFrame: (i.attributes?.timeFrame ?? 'unknown').toLowerCase(),
      startDate: i.attributes?.startDate ?? null,
      finishDate: i.attributes?.finishDate ?? null,
    }));
  }

  /**
   * Creates an iteration under the project root, and adds it to the team's backlog.
   *
   * Two calls, because they are two different things in Azure DevOps: the classification node makes
   * the iteration *exist*, and the team subscription makes it appear on that team's board. An
   * iteration that exists but is not subscribed can be written onto a work item and will still be
   * invisible everywhere a person looks — which is the same failure as writing into a closed sprint,
   * reached a different way.
   *
   * Already-there (409) is the outcome we wanted, so it is not an error.
   */
  async ensureIteration(project: string, team: string, name: string): Promise<void> {
    const nodePath =
      `${encodeURIComponent(project)}/_apis/wit/classificationnodes/iterations` +
      `?api-version=${API_VERSION}`;
    let identifier: string | null = null;
    try {
      const node = await this.request<{ identifier?: string }>('POST', nodePath, { name });
      identifier = node.identifier ?? null;
    } catch (err) {
      if (!/\(409\)/.test((err as Error).message)) throw err;
    }

    if (!identifier) {
      // It already existed; read its id back so it can still be subscribed to the team.
      const read = await this.request<{ identifier?: string }>(
        'GET',
        `${encodeURIComponent(project)}/_apis/wit/classificationnodes/iterations/` +
          `${encodeURIComponent(name)}?api-version=${API_VERSION}`,
      );
      identifier = read.identifier ?? null;
    }
    if (!identifier) return;

    const teamPath =
      `${encodeURIComponent(project)}/${encodeURIComponent(team)}` +
      `/_apis/work/teamsettings/iterations?api-version=${API_VERSION}`;
    try {
      await this.request('POST', teamPath, { id: identifier });
    } catch (err) {
      if (!/\(409\)/.test((err as Error).message)) throw err;
    }
  }

  /**
   * Sets an iteration's start/finish dates — the **only** thing that decides which sprint Azure
   * DevOps reports as `current`, since `timeFrame` is derived from the calendar and never from the
   * state of the work inside it. `iterationPath` is the team-iteration path (`Project\Sprint 2`);
   * the leading project segment is stripped because classification nodes are addressed relative to
   * the project's root iteration node.
   */
  updateIterationDates(
    project: string,
    iterationPath: string,
    startDate: string,
    finishDate: string,
  ): Promise<unknown> {
    const relative = AdoClientService.relativeIterationPath(project, iterationPath);
    const path =
      `${encodeURIComponent(project)}/_apis/wit/classificationnodes/iterations/${relative}` +
      `?api-version=${API_VERSION}`;
    return this.request('PATCH', path, { attributes: { startDate, finishDate } });
  }

  /** `Project\Release 1\Sprint 2` → `Release%201/Sprint%202` (path relative to the root node). */
  static relativeIterationPath(project: string, iterationPath: string): string {
    const segments = iterationPath
      .split(/[\\/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments[0]?.toLowerCase() === project.trim().toLowerCase()) {
      segments.shift();
    }
    return segments.map(encodeURIComponent).join('/');
  }

  /** Fetches a batch of work items with the requested fields (read-only, for the board). */
  async getWorkItemsBatch(ids: number[], fields: string[]): Promise<AdoWorkItem[]> {
    if (ids.length === 0) return [];
    const path = `_apis/wit/workitemsbatch?api-version=${API_VERSION}`;
    const res = await this.request<{ value: AdoWorkItem[] }>('POST', path, { ids, fields });
    return res.value;
  }

  /**
   * The links on a batch of work items.
   *
   * A separate call from {@link getWorkItemsBatch} because Azure DevOps will not return fields and
   * relations together — `$expand` and `fields` are mutually exclusive on `workitemsbatch`. Used to
   * find the Story a Bug belongs to when QA linked it as *related* rather than as a child, which is
   * what silently broke the fix-and-retest loop for four Bugs.
   */
  async getWorkItemRelations(ids: number[]): Promise<{ id: number; relations: AdoRelation[] }[]> {
    if (ids.length === 0) return [];
    const path = `_apis/wit/workitemsbatch?api-version=${API_VERSION}`;
    const res = await this.request<{ value: { id: number; relations?: AdoRelation[] }[] }>(
      'POST',
      path,
      { ids, $expand: 'Relations' },
    );
    return res.value.map((item) => ({ id: item.id, relations: item.relations ?? [] }));
  }

  /**
   * Runs a WIQL query in `project` and returns the matching work-item ids (read-only). Used to
   * enumerate the eligible-Task set for batch dispatch (Phase 2.1). JSON.stringify escapes the area
   * path backslash, so the caller passes the WIQL with a literal `\` in the path.
   */
  async queryWorkItemIds(project: string, wiql: string): Promise<number[]> {
    const path = `${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_VERSION}`;
    const res = await this.request<{ workItems?: { id: number }[] }>('POST', path, { query: wiql });
    return (res.workItems ?? []).map((w) => w.id);
  }

  /**
   * Returns the ids of **Test Cases linked to a Story** (Story `--Tested By-->` Test Case), read via
   * a WorkItemLinks WIQL (Phase 3 Test tab). One-directional/read-only. The source Story node has a
   * null `rel`, so it is filtered out and only the linked Test Case targets are returned.
   */
  async queryLinkedTestCaseIds(project: string, storyId: number): Promise<number[]> {
    const wiql =
      `SELECT [System.Id] FROM WorkItemLinks ` +
      `WHERE ([Source].[System.Id] = ${storyId}) ` +
      `AND ([Target].[System.WorkItemType] = 'Test Case') ` +
      `AND ([System.Links.LinkType] = 'Microsoft.VSTS.Common.TestedBy-Forward') ` +
      `MODE (MustContain)`;
    const path = `${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_VERSION}`;
    const res = await this.request<{
      workItemRelations?: { rel: string | null; target?: { id: number } }[];
    }>('POST', path, { query: wiql });
    const ids = (res.workItemRelations ?? [])
      .filter((r) => r.rel && r.target)
      .map((r) => r.target!.id);
    return [...new Set(ids)];
  }

  /**
   * Best-effort read of the latest Test **Results** for a set of Test Cases (Phase 3 Test tab,
   * D-020 REST path). Returns `{ testCaseId, outcome, completedDate }` records for the caller to
   * reduce to a latest-per-case outcome. Any failure (API shape/permission/absence) degrades to an
   * empty list — the tab then shows `NotRun` rather than erroring, since the **work-item state**
   * remains the authoritative signal (the board reads that, not this projection).
   */
  async queryTestResultsForCases(
    project: string,
    testCaseIds: number[],
  ): Promise<{ testCaseId: number; outcome?: string; completedDate?: string }[]> {
    if (testCaseIds.length === 0) {
      return [];
    }
    const path = `${encodeURIComponent(project)}/_apis/test/results/query?api-version=${API_VERSION}`;
    const res = await this.request<{
      results?: {
        testCase?: { id?: number | string };
        outcome?: string;
        completedDate?: string;
      }[];
    }>('POST', path, { query: { testCaseIds } });
    return (res.results ?? [])
      .map((r) => ({
        testCaseId: Number(r.testCase?.id),
        outcome: r.outcome,
        completedDate: r.completedDate,
      }))
      .filter((r) => Number.isInteger(r.testCaseId));
  }
}

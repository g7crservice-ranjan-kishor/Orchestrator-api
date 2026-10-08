import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { findActiveDraft } from '../planning/draft-repository';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdoClientService, AdoRepository } from './ado-client.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDocument } from '../projects/schemas/project.schema';
import { CreateProjectDto } from '../projects/dto/create-project.dto';
import {
  describeProcesses,
  pickProcess,
  projectNameProblem,
  REQUIRED_PROCESS,
  tidyProjectName,
  toProjectDescription,
} from './process-template';
import { Draft, DraftDocument } from '../planning/schemas/draft.schema';
import { configurationNeeds, ConfigurationNeeds } from '../planning/configuration-needs';
import { DatabaseChoice } from '../projects/database-choice';
import { UiStyleChoice } from '../projects/ui-style-choice';

/** What the plan says still has to be decided, and what has been decided already. */
export interface ProjectConfiguration extends ConfigurationNeeds {
  /** False while there is no plan yet — nothing can be derived, so nothing is asked. */
  planReady: boolean;
  /** The database currently chosen, or 'unset' when the planner was left to decide. */
  database: DatabaseChoice;
  /** True once a database has been chosen deliberately for a product that needs one. */
  databaseConfigured: boolean;
  /** The clone URLs already recorded on the project. */
  configuredRepositories: string[];
  /** The interface framework currently set on the project. */
  currentUiStyle: UiStyleChoice;
}

/** A project that has been created and set up, with anything that could not be done. */
export interface ProvisionedProject {
  project: ProjectDocument;
  /**
   * Setup steps that did not succeed, in plain words. The project still exists — a token that
   * cannot create an area path today may be able to tomorrow, and losing the project over it would
   * help no one.
   */
  warnings: string[];
}

/** What a token can see, checked before a project is created from it. */
export interface PreflightResult {
  /** True when the token authenticated and could list the organization. */
  ok: boolean;
  /** Why not, in words the person setting up the project can act on. Null when `ok`. */
  problem: string | null;
  projects: string[];
  /** Empty unless a project was named. */
  areaPaths: string[];
  /** Empty unless a project was named. */
  repositories: string[];
  /**
   * Whether this organization offers the process the orchestrator needs.
   *
   * Null when the token could not list processes at all, which is a narrower permission than
   * listing projects and not worth failing the whole check over.
   */
  canCreateProjects: boolean | null;
  /** Why a project cannot be created here. Null when one can. */
  processProblem: string | null;
}

/**
 * Turns "here is my organization and a token" into a project that is actually ready to run.
 *
 * Everything the orchestrator needs in Azure DevOps — the area path work items live under, the
 * repositories the pods clone — used to be typed in by hand and believed. A wrong area path finds
 * no work and looks like an empty backlog; a wrong clone URL fails inside a pod half an hour later.
 * Both are cheap to get right here, where the answer can be read back from Azure DevOps itself.
 */
@Injectable()
export class AdoProvisioningService {
  private readonly logger = new Logger(AdoProvisioningService.name);

  constructor(
    private readonly ado: AdoClientService,
    private readonly projects: ProjectsService,
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
  ) {}

  /**
   * What the project still has to be configured with, read from its own plan.
   *
   * Configuration is asked for after planning rather than before it, because before it nobody —
   * including the person filling in the form — knows whether the product stores anything or how
   * many repositories it is. Answering from the plan means the question is only ever asked when it
   * has an answer, and the answer is about the product that is actually being built.
   */
  async configuration(projectId: string): Promise<ProjectConfiguration> {
    const project = await this.projects.findById(projectId);
    const draft = await findActiveDraft(this.draftModel, projectId);
    const plan = draft?.planMarkdown ?? '';
    const needs = plan
      ? configurationNeeds(plan, project.name)
      : {
          needsDatabase: false,
          databaseEvidence: null,
          serverless: false,
          repositories: [],
          uiStyle: null,
        };
    return {
      ...needs,
      planReady: Boolean(plan),
      database: project.database,
      // 'unset' is the one value that means nobody decided.
      databaseConfigured: project.database !== 'unset',
      configuredRepositories: project.targetRepos,
      currentUiStyle: project.uiStyle,
    };
  }

  /**
   * Records the database and creates the repositories the plan calls for.
   *
   * Changing the database after a plan exists makes that plan wrong — it was written against a
   * different one — so the caller is told to regenerate it. Saying so is the whole point of doing
   * this here: a plan that quietly disagrees with the database is the failure this step prevents.
   */
  async applyConfiguration(
    projectId: string,
    input: { database?: DatabaseChoice; repositories?: string[]; uiStyle?: UiStyleChoice },
  ): Promise<{ project: ProjectDocument; replanNeeded: boolean }> {
    const before = await this.projects.findById(projectId);
    const replanNeeded =
      input.database !== undefined &&
      input.database !== before.database &&
      Boolean((await findActiveDraft(this.draftModel, projectId))?.planMarkdown);

    if (input.database !== undefined || input.uiStyle !== undefined) {
      await this.projects.update(projectId, {
        ...(input.database !== undefined ? { database: input.database } : {}),
        ...(input.uiStyle !== undefined ? { uiStyle: input.uiStyle } : {}),
      });
    }
    const project = input.repositories?.length
      ? await this.ensureRepositories(projectId, input.repositories)
      : await this.projects.findById(projectId);

    if (replanNeeded) {
      this.logger.log(
        `Project ${projectId}: database changed to '${input.database}'; the plan needs regenerating.`,
      );
    }
    return { project, replanNeeded };
  }

  /**
   * Checks a token against an organization and reports what it can see.
   *
   * This runs before anything is stored, so a token that is wrong, expired, or scoped too narrowly
   * is caught while the person is still looking at the form — instead of surfacing as an opaque 401
   * in a pod hours later. It never throws on a bad token: "your token did not work" is an answer,
   * not a server error.
   */
  async preflight(orgUrl: string, pat: string, project?: string | null): Promise<PreflightResult> {
    const client = this.ado.withCredentials(orgUrl, pat);
    const empty = {
      projects: [],
      areaPaths: [],
      repositories: [],
      canCreateProjects: null,
      processProblem: null,
    };
    let projects: string[];
    try {
      projects = (await client.listProjects()).map((p) => p.name);
    } catch (err) {
      this.logger.warn(`Preflight against ${orgUrl} failed: ${(err as Error).message}`);
      return {
        ok: false,
        problem:
          'That token could not read the organization. Check the organization URL, that the token ' +
          'has not expired, and that it grants Work Items (read & write), Code (read & write) and ' +
          'Project and Team (read) access.',
        ...empty,
      };
    }

    // Whether a new project can be made here is part of "what can this token see", and it is
    // asked once rather than at the moment of creating — a token that cannot do it should say so
    // while someone is still filling in the form.
    const { canCreateProjects, processProblem } = await this.checkProcess(client);

    if (!project) {
      return { ok: true, problem: null, ...empty, projects, canCreateProjects, processProblem };
    }
    if (!projects.some((p) => p.toLowerCase() === project.toLowerCase())) {
      return {
        ok: false,
        problem: `The organization has no project called '${project}' that this token can see.`,
        ...empty,
        projects,
        canCreateProjects,
        processProblem,
      };
    }

    // Best-effort: a token may legitimately read projects but not repositories. That is worth
    // showing as an empty list the person can still type into, not as a failed preflight.
    const [areaPaths, repositories] = await Promise.all([
      client.listAreaPaths(project).catch(() => [] as string[]),
      client
        .listRepositories(project)
        .then((repos) => repos.map((r) => r.name))
        .catch(() => [] as string[]),
    ]);
    return {
      ok: true,
      problem: null,
      projects,
      areaPaths,
      repositories,
      canCreateProjects,
      processProblem,
    };
  }

  /**
   * Creates a project and sets it up in Azure DevOps in one step.
   *
   * Creation and setup are one action from the outside, so they are one call: a project whose area
   * path was never created is not a project anyone wanted. Setup that fails is reported rather than
   * thrown, because the project itself is fine and the step can be retried.
   */
  async provisionProject(dto: CreateProjectDto, createdBy: string): Promise<ProvisionedProject> {
    const project = await this.projects.create(dto, createdBy);
    const id = project.id as string;
    const warnings: string[] = [];

    // Creating the Azure DevOps project is the one step that cannot be a warning: everything after
    // it — the area path, the repositories, the push — addresses a project that would not exist.
    // The orchestrator project is removed again so a failed setup leaves nothing half-made.
    if (dto.createAdoProject) {
      try {
        await this.createAdoProject(id, dto.adoTarget.project, dto.description ?? '');
      } catch (err) {
        await this.projects.remove(id).catch(() => undefined);
        throw err;
      }
    }

    try {
      await this.ensureAreaPath(id);
    } catch (err) {
      warnings.push(
        `The area path '${dto.adoTarget.areaPath}' could not be created: ${(err as Error).message}`,
      );
    }
    return { project: await this.projects.findById(id), warnings };
  }

  /**
   * Can a project be created in this organization, on the process the orchestrator needs?
   *
   * Two separate things can be wrong and they need different answers: the token may not be allowed
   * to list processes at all (a narrower permission than listing projects), or the organization
   * may simply not offer Scrum.
   */
  private async checkProcess(
    client: AdoClientService,
  ): Promise<{ canCreateProjects: boolean | null; processProblem: string | null }> {
    try {
      const processes = await client.listProcesses();
      const chosen = pickProcess(processes);
      if (chosen) return { canCreateProjects: true, processProblem: null };
      return {
        canCreateProjects: false,
        processProblem:
          `This organization offers no ${REQUIRED_PROCESS} process (it has: ` +
          `${describeProcesses(processes)}). The orchestrator drives work items with ` +
          `${REQUIRED_PROCESS} states, so a project on another process would be created and then ` +
          'never move. Pick an existing project instead, or add the process to the organization.',
      };
    } catch {
      return {
        canCreateProjects: null,
        processProblem:
          "This token cannot list the organization's processes, so a new project cannot be " +
          'created with it. Pick an existing project, or use a token with Project and Team ' +
          '(read, write & manage).',
      };
    }
  }

  /**
   * Creates the Azure DevOps project for a product, on the process the orchestrator needs.
   *
   * One Azure DevOps project per product, rather than many products sharing one and separated by
   * area path. Area paths isolate *what* the work is; iterations do not follow them, so products
   * sharing a project also share one sprint timeline — a second product inherits the first one's
   * active sprint, and completing a sprint on one board moves the other's. Giving each product its
   * own project makes the sprints its own by construction, with nothing to isolate.
   */
  async createAdoProject(projectId: string, name: string, description: string): Promise<void> {
    // Both are usually pasted, and Azure DevOps refuses control characters outright — a tab in a
    // description came back naming a character nobody can see, in a parameter nobody typed.
    // Only the invisible characters are cleaned. The ones Azure DevOps forbids outright are left
    // for `projectNameProblem` to ask about, rather than silently creating a differently-named
    // project the person then has to discover.
    const cleanName = tidyProjectName(name);
    const cleanDescription = toProjectDescription(description);
    const problem = projectNameProblem(cleanName);
    if (problem) throw new BadRequestException(problem);

    const client = this.ado.for(projectId);
    const processes = await client.listProcesses();
    const chosen = pickProcess(processes);
    if (!chosen) {
      throw new BadRequestException(
        `This organization offers no ${REQUIRED_PROCESS} process (it has: ` +
          `${describeProcesses(processes)}).`,
      );
    }

    const existing = await client.listProjects();
    if (existing.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new BadRequestException(
        `Azure DevOps already has a project called '${cleanName}'. Pick that one instead of ` +
          'creating it, or choose another name.',
      );
    }

    this.logger.log(`Creating Azure DevOps project '${cleanName}' on the ${chosen.name} process.`);
    await client.createProject(cleanName, cleanDescription, chosen.id);
    this.logger.log(`Azure DevOps project '${cleanName}' is ready.`);
  }

  /**
   * Makes sure the project's configured area path exists in Azure DevOps, creating it if not.
   *
   * An area path that does not exist is the worst kind of misconfiguration: every query succeeds
   * and returns nothing, so the project looks set up and simply never finds any work.
   */
  async ensureAreaPath(projectId: string): Promise<string> {
    const project = await this.projects.findById(projectId);
    const full = await this.ado
      .for(projectId)
      .ensureAreaPath(project.adoTarget.project, project.adoTarget.areaPath);
    if (full !== project.adoTarget.areaPath) {
      await this.projects.update(projectId, {
        adoTarget: { ...project.adoTarget, areaPath: full },
      });
      this.logger.log(`Project ${projectId}: area path normalised to '${full}'.`);
    }
    return full;
  }

  /**
   * Creates the named repositories if they do not exist and records their clone URLs on the project.
   *
   * The names come from the plan, so the repositories a product needs are decided by what is being
   * built rather than guessed up front. Storing the URL Azure DevOps reports — rather than one
   * assembled from the organization and project names — is what stops a pod cloning an address that
   * merely looks right.
   */
  async ensureRepositories(projectId: string, names: string[]): Promise<ProjectDocument> {
    const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) {
      throw new BadRequestException('Name at least one repository to create.');
    }
    const project = await this.projects.findById(projectId);
    const client = this.ado.for(projectId);
    const created: AdoRepository[] = [];
    for (const name of wanted) {
      created.push(await client.ensureRepository(project.adoTarget.project, name));
    }
    // Keep anything already configured: re-running configuration must never drop a repository a
    // sprint is already pointed at.
    const urls = [...new Set([...project.targetRepos, ...created.map((r) => r.remoteUrl)])];
    this.logger.log(`Project ${projectId}: ${urls.length} target repositories configured.`);
    return this.projects.update(projectId, { targetRepos: urls });
  }
}

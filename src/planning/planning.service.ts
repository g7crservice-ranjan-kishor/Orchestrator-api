import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { allDrafts, findActiveDraft } from './draft-repository';
import {
  ClarificationInput,
  normaliseCategory,
  selectClarifications,
  unanswered,
} from './clarification-analysis';
import {
  TechnicalDetail,
  TechnicalField,
  detectFromRequirement,
  resolveTechnicalDetails,
  unansweredQuestions,
  isDatabaseType,
} from './technical-details';
import { DATABASE_LABELS } from '../projects/database-choice';
import { UI_STYLE_LABELS } from '../projects/ui-style-choice';
import { KnowledgeBaseService } from '../knowledge/knowledge-base.service';
import { draftLabel, enhancementRef, nextSeq, unfinishedDraft } from './draft-selection';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../common/config/app-config.service';
import { AppSecretsService, ENV_NAME } from '../common/secrets/app-secrets.service';
import { JobsService } from '../jobs/jobs.service';
import { JobRole, PermissionMode } from '../jobs/job-state';
import { EXECUTION_BACKEND, ExecutionBackend } from '../jobs/execution-backend';
import { RunTokenService } from '../common/security/run-token.service';
import { ProjectsService } from '../projects/projects.service';
import { databaseConstraint } from '../projects/database-choice';
import { uiStyleConstraint } from '../projects/ui-style-choice';
import { planFeedbackFor, stripPlanPreamble, validatePlan } from './plan-validation';
import { ValidationIssue, validateBacklog } from './backlog-validation';
import { mergeBacklog } from './backlog-merge';
import { stalledOutcome } from './stalled-run';
import { repoNameOf } from '../development/repo-resolution';
import { RequirementsService } from '../requirements/requirements.service';
import { AdoClientService } from '../ado/ado-client.service';
import { Draft, DraftDocument, DraftKind, DraftStatus } from './schemas/draft.schema';

/** Per-run token lifetime — must exceed the longest possible run (Job activeDeadline is 1h). */
const RUN_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** The specific ADO work item an execution run implements/tests (Developer/QA), read via REST. */
export interface RunWorkItem {
  id: number;
  type: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** Azure DevOps Bugs carry the failure in `Repro Steps`, not Description — QA writes it there. */
  reproSteps: string;
}

/** Grounding context handed to the Agent Runner so it can plan/draft against the requirement. */
export interface RunContext {
  runId: string;
  role: JobRole;
  projectId: string;
  requirementText: string;
  planMarkdown: string | null;
  /** "Request changes" feedback for an EM regeneration; null on a first plan / SM run. */
  planFeedback: string | null;
  /** The ADO work item to implement/test (Developer/QA runs); null for planning runs. */
  workItem: RunWorkItem | null;
  /**
   * The database the project is built against, or null when the project imposes no constraint.
   * Steers planning instead of letting the agent infer a database from the requirement prose.
   */
  database: { id: string; label: string; guidance: string } | null;
  /** How the generated interface should be built and styled; null when unconstrained. */
  uiStyle: { id: string; label: string; guidance: string } | null;
  /**
   * The technology decisions already made for this product, and where each came from.
   *
   * Every one was named in the requirement or set on the project, and a person has reviewed the
   * table before approving. Passing them on is what stops the agent deciding again: the Employee
   * Management System's plan named PostgreSQL while the project was pinned to SQL Server, because
   * nothing in the prompt said the choice was already made.
   */
  technicalDetails: { label: string; value: string | null; source: string }[];
  /**
   * Set when this run is planning a **change to a product that already exists**; null otherwise.
   *
   * Without it the agent gets the ordinary "plan a product" template and does exactly that. ENH-001
   * on the Employee Management System came back as the whole product planned again — six epics of
   * login, CRUD and scaffolding that had been built and pushed days earlier — because nothing in
   * its prompt said the product was already there.
   */
  /**
   * The project's knowledge base — what this product is, and the rules anything built for it
   * follows. Empty when the project has none, or when the store is unreachable.
   *
   * Four role templates already say "follow the Knowledge Base". Until this existed nothing ever
   * wrote one, so every run read that instruction and found nothing — and rediscovered the
   * product's conventions from the code instead, at a cost of up to a million tokens a run.
   */
  knowledge: { name: string; text: string }[];
  enhancement: {
    /** `ENH-001`. */
    ref: string;
    /** What the person called it. */
    title: string;
    /** The plan the product was built from, so the change can be placed against it. */
    existingPlan: string | null;
  } | null;
  /**
   * The repositories this project targets, by name. Without them the planning agent invents names
   * from the requirement prose (`task-manager-api` for a repo actually called `taskmanager-api`),
   * and every Task it writes then fails to resolve a repository.
   */
  targetRepos: string[];
  /**
   * The project's *other* repositories, as clone URLs — populated for QA runs only, empty otherwise.
   *
   * A QA pod clones the one repository its work item is tagged with. For the Story that verifies
   * the application end to end that is not enough: with only the API checked out, QA verified the
   * journey with curl and passed it, and the defects that live *between* the two apps — no CORS,
   * and a task list that renders blank — could not be reached. QA never commits, so a second
   * shallow clone costs little and removes the blind spot.
   */
  companionRepos: string[];
}

/**
 * Orchestrates the planning pipeline (EM plan → clarifications → SM backlog) with **no side
 * effects** until approval. Dispatches EM/SM runs through the jobs table + AKSExecutionBackend and
 * ingests their `plan.md` / `backlog.json` output into the per-project draft. Planning is gated:
 * the SM backlog cannot start until the plan is approved and every clarification is answered.
 */
@Injectable()
export class PlanningService {
  private readonly logger = new Logger(PlanningService.name);

  constructor(
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
    private readonly projects: ProjectsService,
    private readonly requirements: RequirementsService,
    private readonly jobs: JobsService,
    @Inject(EXECUTION_BACKEND) private readonly execution: ExecutionBackend,
    private readonly runTokens: RunTokenService,
    private readonly config: AppConfigService,
    private readonly ado: AdoClientService,
    private readonly appSecrets: AppSecretsService,
    /*
     * Last on purpose. Specs construct this service positionally, so a parameter added in the
     * middle silently shifts every argument after it into the wrong slot — which is exactly what
     * happened, and `tsc` did not catch it because `tsconfig.json` excludes `*.spec.ts`.
     */
    private readonly knowledge: KnowledgeBaseService,
  ) {}

  private get backendEventsUrl(): string {
    // The runner posts to `${base}/runs/:id/...`; the API mounts everything under the global
    // `/api` prefix (main.ts), so the base must include it.
    return process.env.BACKEND_EVENTS_URL ?? `http://localhost:${this.config.port}/api`;
  }

  private get claudeAuthMode(): string {
    return process.env.CLAUDE_AUTH_MODE ?? 'subscription';
  }

  /**
   * The plan being worked on, creating the project's initial one on first access.
   *
   * A project may now hold an initial plan and its enhancements; "the project's draft" means the
   * one in flight, else the most recent. For a project with a single plan that is the same document
   * `findOne` returned, which is why nothing here behaves differently until an enhancement exists.
   */
  async getOrCreateDraft(projectId: string): Promise<DraftDocument> {
    await this.projects.findById(projectId); // 404 if the project is unknown
    const existing = await findActiveDraft(this.draftModel, projectId);
    if (existing) {
      return this.ensureTechnicalDetails(
        await this.reconcileProvidedSecrets(existing, projectId),
        projectId,
      );
    }
    return new this.draftModel({
      projectId: new Types.ObjectId(projectId),
      kind: DraftKind.Initial,
      seq: 0,
    }).save();
  }

  async getDraftByProject(projectId: string): Promise<DraftDocument> {
    const draft = await findActiveDraft(this.draftModel, projectId);
    if (!draft) {
      throw new NotFoundException('No planning draft for this project yet.');
    }
    return this.ensureTechnicalDetails(
      await this.reconcileProvidedSecrets(draft, projectId),
      projectId,
    );
  }

  /**
   * Marks as provided any credential the project already holds in Key Vault.
   *
   * Done on **read**, not only when a plan declares its credentials, because the two happen at
   * different times and the reader is the one being misled. ENH-001's list was written by a run
   * that recorded every credential as missing; the values had been in the vault since the initial
   * build, and the screen said "Not set" beside four of them with the plan unapprovable until
   * someone re-typed a connection string they cannot read back.
   *
   * Cheap in the ordinary case: a plan whose credentials are all recorded as provided asks the
   * vault nothing. The result is saved, so the correction happens once rather than on every load.
   *
   * Best-effort — an unreachable vault must not stop a draft being read. It then reports what it
   * last knew, which is what it did before this existed.
   */
  private async reconcileProvidedSecrets(
    draft: DraftDocument,
    projectId: string,
  ): Promise<DraftDocument> {
    const missing = draft.requiredSecrets.filter((secret) => !secret.provided);
    if (missing.length === 0) return draft;

    try {
      const held = new Set(
        await this.appSecrets.existing(
          projectId,
          missing.map((secret) => secret.name),
        ),
      );
      if (held.size === 0) return draft;

      for (const secret of draft.requiredSecrets) {
        if (!secret.provided && held.has(secret.name)) {
          secret.provided = true;
          secret.providedAt = secret.providedAt ?? new Date();
        }
      }
      draft.markModified('requiredSecrets');
      return await draft.save();
    } catch (err) {
      this.logger.warn(
        `Could not check stored credentials for ${projectId}: ${(err as Error).message}`,
      );
      return draft;
    }
  }

  private async findDraftByRun(runId: string): Promise<DraftDocument> {
    const draft = await this.draftModel.findOne({ currentRunId: runId });
    if (!draft) {
      throw new NotFoundException(`No draft found for run ${runId}.`);
    }
    return draft;
  }

  /**
   * Grounding context for the Agent Runner (worker-facing, run-token authed): the requirement to
   * plan against and the approved plan (for the SM backlog session). Lets the runner build a
   * prompt from data it does not otherwise have — the backend sends references, never the composed
   * prompt.
   */
  async getRunContext(runId: string): Promise<RunContext> {
    // Resolve via the job (works for every run), not the draft's currentRunId (planning-only).
    const job = await this.jobs.getByRunId(runId);
    const projectId = job.projectId.toString();
    const draft = await findActiveDraft(this.draftModel, projectId);
    // Best-effort: a run must still be groundable if the project row cannot be read.
    const project = await this.projects.findById(projectId).catch(() => null);
    let requirementText = '';
    if (draft?.requirementId) {
      const requirement = await this.requirements.findById(draft.requirementId.toString());
      requirementText = requirement.text;
    }
    // Execution runs (Developer/QA) are grounded by the specific ADO work item, fetched here via the
    // backend's REST client so the agent gets the task title/description/AC in its prompt (the in-pod
    // ADO MCP is not relied upon — the backend owns ADO reads/writes).
    let workItem: RunWorkItem | null = null;
    const isExecution = job.role === JobRole.Developer || job.role === JobRole.QA;
    if (isExecution && job.workItemId) {
      workItem = await this.fetchWorkItem(job.workItemId, projectId);
    }
    return {
      runId,
      role: job.role,
      projectId,
      requirementText,
      planMarkdown: draft?.planMarkdown ?? null,
      planFeedback: draft?.planFeedback ?? null,
      workItem,
      database: databaseConstraint(project?.database),
      uiStyle: uiStyleConstraint(project?.uiStyle),
      technicalDetails: (draft?.technicalDetails ?? [])
        .filter((d) => d.value)
        .map((d) => ({ label: d.label, value: d.value, source: d.source })),
      enhancement: await this.enhancementContext(draft, projectId),
      knowledge: await this.knowledge.readAll(projectId),
      targetRepos: (project?.targetRepos ?? []).map(repoNameOf).filter(Boolean),
      /*
       * The project's other repositories, as clone URLs, for a QA run.
       *
       * A QA pod clones the one repository its work item is tagged with, which is right for a Story
       * that lives in one codebase. It is wrong for the Story that verifies the application end to
       * end: QA had the API and no user interface, so it tested the journey with curl, passed it,
       * and never exercised a browser. The two defects that live *between* the apps — no CORS, and
       * a list that renders blank — were unreachable by construction.
       *
       * QA never commits, so handing it every repository costs a shallow clone and removes the
       * blind spot. Developer runs are untouched: one Task, one repository, one commit.
       */
      /*
       * A planning run gets **every** repository, because it targets none of them.
       *
       * The EM agent used to plan from the written requirement alone, having never read a line of
       * the product. That works for a first build, where there is nothing to read, and fails for an
       * enhancement: a plan for "dark mode on every screen" written by an agent that cannot see the
       * screens is a guess, and "do not break what works" cannot be honoured by one that cannot see
       * what works. Planning checks out no branch, builds nothing and commits nothing, so this is a
       * read.
       */
      companionRepos: PlanningService.reposFor(job, project?.targetRepos ?? []),
    };
  }

  /** Reads one ADO work item's grounding fields (best-effort; null if it can't be fetched). */
  private async fetchWorkItem(workItemId: string, owner: string): Promise<RunWorkItem | null> {
    try {
      const [wi] = await this.ado
        .for(owner)
        .getWorkItemsBatch(
          [Number(workItemId)],
          [
            'System.Title',
            'System.Description',
            'System.WorkItemType',
            'Microsoft.VSTS.Common.AcceptanceCriteria',
            'Microsoft.VSTS.TCM.ReproSteps',
          ],
        );
      if (!wi) return null;
      return {
        id: Number(workItemId),
        type: String(wi.fields['System.WorkItemType'] ?? ''),
        title: String(wi.fields['System.Title'] ?? ''),
        description: String(wi.fields['System.Description'] ?? ''),
        acceptanceCriteria: String(wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? ''),
        reproSteps: String(wi.fields['Microsoft.VSTS.TCM.ReproSteps'] ?? ''),
      };
    } catch (err) {
      this.logger.warn(`Could not fetch work item ${workItemId}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Dispatches a planning run: enqueue a job (one active run per project draft) and ask the
   * AKSExecutionBackend to create the pod. If the execution backend is unreachable (e.g. local dev
   * without a cluster) the job stays Queued for a runner to claim — dispatch never hard-fails.
   */
  private async dispatchRun(
    projectId: string,
    role: JobRole,
    permissionMode: PermissionMode,
  ): Promise<string> {
    const runId = randomUUID();
    const job = await this.jobs.enqueue({ runId, role, projectId, permissionMode });
    // A planning run can take many minutes (the Job's activeDeadline is 1h); the per-run token must
    // outlive the whole run, otherwise late posts (plan/backlog/result) are rejected as expired.
    // The default (2× lease TTL) is far too short for a real Claude session.
    const perRunToken = await this.runTokens.issue(runId, RUN_TOKEN_TTL_MS);
    try {
      await this.execution.startRun(job, {
        backendEventsUrl: this.backendEventsUrl,
        perRunToken,
        claudeAuthMode: this.claudeAuthMode,
      });
    } catch (err) {
      this.logger.warn(
        `Execution backend unavailable for run ${runId}; job left Queued: ${(err as Error).message}`,
      );
    }
    return runId;
  }

  /**
   * Work items this project has already created in Azure DevOps, from its plan.
   *
   * Used to refuse a re-plan that would destroy the link to them — see {@link startEmPlanning}.
   */
  static pushedItemCount(draft: DraftDocument): number {
    return draft.backlog.filter((item) => typeof item.adoId === 'number').length;
  }

  /** Starts (or restarts) the EM planning session for a project. */
  async startEmPlanning(projectId: string): Promise<DraftDocument> {
    const draft = await this.getOrCreateDraft(projectId);
    const requirements = await this.requirements.listForProject(projectId);
    if (requirements.length === 0) {
      throw new BadRequestException('Submit a requirement before starting planning.');
    }

    /*
     * A project whose plan has been pushed cannot be re-planned in place.
     *
     * Planning again looks harmless: submit a new requirement, press the button. What actually
     * happens is destructive. A fresh Scrum Master run **replaces** `draft.backlog` outright
     * (merging is for corrections only), so every item's `adoId` is lost. The work items stay in
     * Azure DevOps, orphaned: the board can no longer find them, nothing knows which Task a commit
     * belongs to, and the dependency lookup — which reads `adoId` to work out what a Task is
     * waiting for — goes blind. It would also re-plan the *first* requirement rather than the new
     * one, because that is the one the draft points at.
     *
     * Enhancements are a separate planning cycle for exactly this reason: a new draft, its own
     * plan and backlog, pushed alongside the first rather than over it.
     */
    const pushed = PlanningService.pushedItemCount(draft);
    if (pushed > 0) {
      throw new BadRequestException(
        `This project's plan is already in Azure DevOps (${pushed} work items). Planning again ` +
          'would replace the backlog and lose the link to them, leaving the work items orphaned ' +
          'on the board. To add to a product that has already been planned, start an enhancement ' +
          'instead — it plans on top of what is there and leaves the existing work alone.',
      );
    }
    draft.requirementId = requirements[0]._id as Types.ObjectId;
    draft.currentRunId = await this.dispatchRun(projectId, JobRole.EM, PermissionMode.Plan);
    draft.status = DraftStatus.Planning;
    return draft.save();
  }

  /**
   * Starts a new planning cycle on a product that has already been built.
   *
   * An enhancement is a *separate draft*, not an edit of the first one — which is what lets every
   * existing piece of machinery work on it unchanged: the EM session, the clarification thread, the
   * backlog gates, the push, both queues and QA all act on "the project's plan", and an enhancement
   * simply becomes that plan while it is in flight.
   *
   * Two refusals, both of which keep that sentence true:
   *
   * - **One cycle at a time.** Two unfinished plans would make "the project's plan" unanswerable
   *   for the agents and the queues.
   * - **Nothing to enhance.** If the initial plan has never reached Azure DevOps there is no built
   *   product to add to, and editing that plan is what the person actually wants.
   */
  async startEnhancement(
    projectId: string,
    input: { title: string; requirementId?: string | null; sprintAnchor?: 'current' | 'next' },
  ): Promise<DraftDocument> {
    await this.projects.findById(projectId); // 404 if the project is unknown

    const title = (input.title ?? '').trim();
    if (!title) {
      throw new BadRequestException('Give the enhancement a title.');
    }

    const drafts = await allDrafts(this.draftModel, projectId);
    const inFlight = unfinishedDraft(drafts);
    if (inFlight) {
      throw new BadRequestException(
        `${draftLabel(inFlight)} is still being planned (${inFlight.status}). Finish or approve it ` +
          'before starting another enhancement — one planning cycle runs at a time.',
      );
    }

    const built = drafts.reduce((n, d) => n + PlanningService.pushedItemCount(d), 0);
    if (built === 0) {
      throw new BadRequestException(
        'This project has nothing in Azure DevOps yet, so there is nothing to enhance. Change the ' +
          'existing plan instead, and push it when it is right.',
      );
    }

    /*
     * The newest requirement — the one just written for this enhancement.
     *
     * Picked by date rather than by position. `listForProject` sorts newest first, and reading the
     * *last* element of it handed ENH-001 the project's **original** requirement: the agent was
     * asked to plan "Build a simple Employee Management System" and dutifully planned the whole
     * product again, six epics of work that already exists. Sorting here means the answer no longer
     * depends on a sort order defined in another file.
     */
    const requirements = await this.requirements.listForProject(projectId);
    const newest = [...requirements].sort(
      (a, b) => PlanningService.createdAtOf(b) - PlanningService.createdAtOf(a),
    )[0];
    const requirementId =
      input.requirementId ?? (newest?._id as Types.ObjectId | undefined) ?? null;

    const draft = new this.draftModel({
      projectId: new Types.ObjectId(projectId),
      kind: DraftKind.Enhancement,
      seq: nextSeq(drafts),
      title,
      requirementId,
      sprintAnchor: input.sprintAnchor ?? 'current',
      status: DraftStatus.Planning,
    });
    draft.currentRunId = await this.dispatchRun(projectId, JobRole.EM, PermissionMode.Plan);
    this.logger.log(`${draftLabel(draft)} started for project ${projectId}.`);
    return draft.save();
  }

  /**
   * Works out the product's technical decisions and records them on the draft.
   *
   * Resolved in the order that matters: what the requirement says, then what the project already
   * decided, then nothing — which becomes a question. An answer a person has already given is
   * never re-derived, because re-reading the requirement would quietly overwrite a correction they
   * made on purpose.
   */
  async refreshTechnicalDetails(projectId: string): Promise<DraftDocument> {
    const draft = await this.getOrCreateDraft(projectId);
    return this.resolveDetailsOnto(draft, projectId);
  }

  /**
   * Resolves the technical details if the draft has none yet.
   *
   * Done on read, the same way a credential already in Key Vault is recognised on read: the two
   * events — a requirement being written, and this draft being looked at — happen at different
   * times, and the reader is the one who needs the answer. Without it a person would have to know
   * to press a button before the table meant anything.
   */
  private async ensureTechnicalDetails(
    draft: DraftDocument,
    projectId: string,
  ): Promise<DraftDocument> {
    if (draft.technicalDetails.length > 0) return draft;
    try {
      return await this.resolveDetailsOnto(draft, projectId);
    } catch {
      // Reading a draft worked before this existed and must keep working. A table that is briefly
      // empty is a smaller failure than a planning page that will not open.
      return draft;
    }
  }

  private async resolveDetailsOnto(
    draft: DraftDocument,
    projectId: string,
  ): Promise<DraftDocument> {
    const requirements = await this.requirements.listForProject(projectId);
    if (requirements.length === 0) return draft; // nothing written to read yet
    const project = await this.projects.findById(projectId).catch(() => null);
    // Oldest first, so "the newest" and "everything before it" are both unambiguous. Picked by
    // date rather than by position: `listForProject` sorts newest first, and reading the array
    // the other way round is how an enhancement came to be planned from the original requirement.
    const byDate = [...requirements].sort(
      (a, b) => PlanningService.createdAtOf(a) - PlanningService.createdAtOf(b),
    );
    const newest = byDate[byDate.length - 1];
    const older = byDate.slice(0, -1);

    const answered = new Map(
      draft.technicalDetails.filter((d) => d.source === 'user').map((d) => [d.field, d]),
    );
    /*
     * What the product was already built with, read from everything written about it before now.
     *
     * A change request describes the change, not the stack: "add a dark mode to the Employee
     * Management System" names no frontend, no language and no backend. Read as a fresh
     * requirement it reports three gaps and asks three questions whose answers are in the
     * repository the change is being made to — and in the requirement that built it.
     *
     * Oldest first, so a later document's answer overrides an earlier one's. Only positives are
     * carried: an older requirement's *exclusions* described a product that did not exist yet,
     * and have no authority over what the product turned out to be.
     */
    const inherited: Partial<Record<TechnicalField, string>> = {};
    for (const earlier of older) {
      Object.assign(inherited, detectFromRequirement(earlier.text ?? ''));
    }

    const resolved = resolveTechnicalDetails(
      newest?.text ?? '',
      {
        database: project ? DATABASE_LABELS[project.database] : null,
        uiFramework: project ? UI_STYLE_LABELS[project.uiStyle] : null,
      },
      inherited,
    );

    draft.technicalDetails = resolved.map((detail: TechnicalDetail) => {
      const byHand = answered.get(detail.field);
      return byHand ?? { ...detail };
    }) as DraftDocument['technicalDetails'];
    draft.markModified('technicalDetails');
    return draft.save();
  }

  /**
   * Records an answer a person gave for one technical detail.
   *
   * Marked `user` so a later refresh leaves it alone: someone who corrected a detected value meant
   * it, and re-reading the requirement would undo that silently.
   */
  async setTechnicalDetail(
    projectId: string,
    field: string,
    value: string,
  ): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    const detail = draft.technicalDetails.find((d) => d.field === field);
    if (!detail) {
      throw new NotFoundException(`'${field}' is not one of this product's technical details.`);
    }
    const answer = (value ?? '').trim();
    if (!answer) {
      throw new BadRequestException(`Give a value for ${detail.label}.`);
    }
    /*
     * 'SQL' is not a database name.
     *
     * The two database rows read as one question asked twice — which kind, then what to call it —
     * and the first real run answered the name with 'SQL'. The predicate that already refuses a
     * database *type* when reading one out of a requirement is applied to typed input too, so the
     * same mistake cannot be saved by hand either.
     */
    if (field === 'databaseName' && isDatabaseType(answer)) {
      throw new BadRequestException(
        ` is a kind of database, not a name for one. Give the name the application will connect to, such as appointment_booking — the kind belongs in the Database row.`,
      );
    }
    detail.value = answer;
    detail.source = 'user';
    draft.markModified('technicalDetails');
    return draft.save();
  }

  /**
   * EM run reports clarifying questions; recorded on the thread (status → Clarifying).
   *
   * What arrives is filtered before anyone sees it, against **every plan this project has ever
   * had** — not just this one. That is the "previously confirmed decisions" step: an enhancement
   * planned weeks after the initial build must not re-open which expense categories exist, and a
   * regeneration must not stack the same unanswered question twice. An answer already given is a
   * fact; asking again invites a second, contradicting one, with nothing to say which the plan was
   * built on.
   */
  async ingestClarifications(
    runId: string,
    incoming: ClarificationInput[],
  ): Promise<DraftDocument> {
    const draft = await this.findDraftByRun(runId);
    const projectId = draft.projectId.toString();

    const drafts = await allDrafts(this.draftModel, projectId).catch(() => [draft]);
    const prior = drafts.flatMap((d) => d.clarifications ?? []);
    const { ask, skipped } = selectClarifications(incoming, prior);

    for (const item of ask) {
      draft.clarifications.push({
        id: randomUUID(),
        question: item.question,
        answer: null,
        answeredAt: null,
        category: normaliseCategory(item.category),
        why: item.why?.trim() || null,
        assumption: item.assumption?.trim() || null,
      });
    }

    if (skipped.length > 0) {
      // Logged rather than discarded quietly: a question that never reached a person is exactly
      // the kind of thing that is later blamed on the agent for not having asked it.
      this.logger.log(
        `Run ${runId}: asked ${ask.length} of ${incoming.length} questions; skipped ` +
          skipped.map((s) => `${s.reason}`).join(', '),
      );
    }

    // Only a question that actually reached someone can be waiting on them. A batch filtered down
    // to nothing means everything was already known, and parking the draft in Clarifying would
    // stall planning on a thread with nothing in it to answer.
    if (unanswered(draft.clarifications).length > 0) {
      draft.status = DraftStatus.Clarifying;
    }
    return draft.save();
  }

  /** Admin answers a clarification. */
  async answerClarification(
    projectId: string,
    clarificationId: string,
    answer: string,
  ): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    const item = draft.clarifications.find((c) => c.id === clarificationId);
    if (!item) {
      throw new NotFoundException('Clarification not found.');
    }
    item.answer = answer;
    item.answeredAt = new Date();
    return draft.save();
  }

  /** True once every clarification has an answer (the block-planning-until-answered guard). */
  static allClarificationsAnswered(draft: DraftDocument): boolean {
    return draft.clarifications.every((c) => c.answer !== null && c.answer !== '');
  }

  /**
   * How many times the orchestrator will ask for the plan again on its own before handing the
   * problem to a human. One is enough in practice and keeps a bad run from burning a budget.
   */
  private static readonly MAX_PLAN_ATTEMPTS = 2;

  /**
   * A hard ceiling on automatic backlog corrections. Each round is cheap and cannot lose work,
   * so the real stop condition is "it stopped improving"; this only bounds a pathological run.
   */
  private static readonly MAX_BACKLOG_ATTEMPTS = 8;

  /**
   * EM run reports the plan; ingested into the editable draft (status → Planned).
   *
   * The plan is then checked against the project's own binding choices, and if it is missing
   * them the orchestrator **regenerates it itself**, feeding back the specific gaps. The EM
   * complies when a human types those gaps into the feedback box and omits them on a fresh
   * run however firmly the template is worded, so this writes that feedback instead of
   * leaving it as a chore for whoever is watching (D-037).
   */
  /**
   * Called when a planning run ends. If the draft is still waiting on that run, the run delivered
   * nothing — so the draft goes back where it was and says why, instead of sitting on "an agent
   * is working" indefinitely while nothing is working.
   */
  async noteRunFinished(runId: string): Promise<void> {
    const draft = await this.draftModel.findOne({ currentRunId: runId });
    if (!draft) return;
    const stalled = stalledOutcome(draft, runId);
    if (!stalled) return;
    draft.status = stalled.status;
    draft.runNote = stalled.message;
    this.logger.warn(
      `Run ${runId} finished without delivering; draft returned to ${stalled.status}.`,
    );
    await draft.save();
  }

  async ingestPlan(runId: string, markdown: string): Promise<DraftDocument> {
    const draft = await this.findDraftByRun(runId);
    const plan = stripPlanPreamble(markdown);
    draft.planMarkdown = plan;
    draft.runNote = null;
    draft.planFeedback = null; // consumed by this regeneration
    draft.status = DraftStatus.Planned;

    const project = await this.projects.findById(draft.projectId.toString()).catch(() => null);
    const issues = validatePlan(plan, {
      uiStyleLabel: uiStyleConstraint(project?.uiStyle)?.label ?? null,
      targetRepos: project?.targetRepos ?? [],
    });
    draft.planIssues = issues.map((i) => i.message);

    if (issues.length > 0 && draft.planAttempts < PlanningService.MAX_PLAN_ATTEMPTS) {
      draft.planAttempts += 1;
      draft.planFeedback = planFeedbackFor(issues);
      draft.currentRunId = await this.dispatchRun(
        draft.projectId.toString(),
        JobRole.EM,
        PermissionMode.Plan,
      );
      draft.status = DraftStatus.Planning;
      this.logger.warn(
        `Plan for project ${draft.projectId.toString()} is missing ${issues.length} required ` +
          `element(s); regenerating automatically (attempt ${draft.planAttempts}).`,
      );
    }
    return draft.save();
  }

  /** Approves the plan (gate before backlog drafting); requires all clarifications answered. */
  async approvePlan(projectId: string): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    if (!draft.planMarkdown) {
      throw new BadRequestException('No plan to approve yet.');
    }
    if (!PlanningService.allClarificationsAnswered(draft)) {
      throw new BadRequestException('Answer all clarifications before approving the plan.');
    }

    /*
     * No plan is approved while a technical decision is still nobody's.
     *
     * An unanswered stack is not an open question to an agent — it is a decision it will make
     * quietly and then build on. The Employee Management System's plan named PostgreSQL for a
     * project pinned to SQL Server, and the mismatch surfaced only when a connection string
     * refused to parse. Asking costs a moment here; the alternative costs a rebuild.
     */
    const unanswered = unansweredQuestions(draft.technicalDetails);
    if (unanswered.length > 0) {
      throw new BadRequestException({
        message:
          `${unanswered.length} technical detail(s) are still unanswered. Choose them before ` +
          'approving, so the plan is built on decisions rather than assumptions.',
        reason: 'technical-details-missing',
        missing: unanswered.map((d) => ({ field: d.field, label: d.label, question: d.question })),
      });
    }

    // The application's own credentials are collected here, before any code is written, so a Task
    // is never dispatched for an app that cannot run (D-029).
    const missing = draft.requiredSecrets.filter((s) => !s.provided).map((s) => s.name);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Provide the application credentials before approving the plan: ${missing.join(', ')}.`,
      );
    }
    draft.planApproved = true;
    return draft.save();
  }

  /**
   * Records the credentials the **generated application** will need at runtime, as declared by the
   * planning agent. Names and descriptions only — values are supplied by a human afterwards and go
   * straight to Key Vault. Re-declaring is idempotent: an entry already provided keeps its status,
   * one that is no longer required is dropped (and its stored value removed).
   */
  async declareRequiredSecrets(
    projectId: string,
    declared: { name: string; description?: string; example?: string }[],
  ): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    const wanted = new Map<string, { description: string; example: string }>();
    for (const d of declared) {
      const name = d.name.trim().toUpperCase();
      if (!ENV_NAME.test(name)) {
        this.logger.warn(`Ignoring '${d.name}': not a valid environment variable name.`);
        continue;
      }
      wanted.set(name, {
        description: d.description?.trim() ?? '',
        example: d.example?.trim() ?? '',
      });
    }

    const previous = new Map(draft.requiredSecrets.map((s) => [s.name, s]));

    /*
     * A credential is only dropped from the vault when **no plan of this project still wants it**.
     *
     * The vault is keyed by project; `requiredSecrets` is per plan. Comparing against this plan
     * alone meant an enhancement declaring one credential would delete the other three — and those
     * three are what the built, running application reads at startup. An enhancement could have
     * taken the live product's database connection string with it.
     */
    const wantedElsewhere = new Set(
      (await allDrafts(this.draftModel, projectId))
        .filter((other) => other.id !== draft.id)
        .flatMap((other) => other.requiredSecrets.map((secret) => secret.name)),
    );
    for (const [name] of previous) {
      if (!wanted.has(name) && !wantedElsewhere.has(name)) {
        await this.appSecrets.remove(projectId, name);
      }
    }

    /*
     * A credential the project already holds is already provided.
     *
     * Without this, every enhancement asks again for `DATABASE_URL`, `JWT_SECRET` and the rest — a
     * person invited to re-enter a connection string that is sitting in the vault, and a plan that
     * cannot be approved until they do. The values are per project, so a second plan has them the
     * moment the first did.
     */
    const held = new Set(await this.appSecrets.existing(projectId, [...wanted.keys()]));

    draft.requiredSecrets = [...wanted].map(([name, meta]) => {
      const before = previous.get(name);
      const provided = before?.provided || held.has(name);
      return {
        name,
        description: meta.description || before?.description || '',
        example: meta.example || before?.example || '',
        provided,
        providedAt: before?.providedAt ?? (provided ? new Date() : null),
      };
    });
    return draft.save();
  }

  /** Same declaration, addressed by run id — the path the EM pod uses (run-token authenticated). */
  async declareRequiredSecretsForRun(
    runId: string,
    declared: { name: string; description?: string; example?: string }[],
  ): Promise<void> {
    const job = await this.jobs.getByRunId(runId);
    await this.declareRequiredSecrets(job.projectId.toString(), declared);
  }

  /**
   * Stores one application credential. The value goes to Key Vault and is never written to the
   * draft — only the fact that it is now set.
   */
  async setRequiredSecret(projectId: string, name: string, value: string): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    const entry = draft.requiredSecrets.find((s) => s.name === name.trim().toUpperCase());
    if (!entry) {
      throw new BadRequestException(`'${name}' is not a credential this application declared.`);
    }
    if (!value.trim()) {
      throw new BadRequestException(`A value is required for ${entry.name}.`);
    }
    await this.appSecrets.set(projectId, entry.name, value);
    entry.provided = true;
    entry.providedAt = new Date();
    return draft.save();
  }

  /**
   * Requests changes: records the admin's feedback and re-dispatches the EM session, which revises
   * the previous plan against that feedback (plan returns to Planning). Feedback is optional.
   */
  async regeneratePlan(projectId: string, feedback?: string): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    draft.planApproved = false;
    draft.planFeedback = feedback?.trim() ? feedback.trim() : null;
    // A human asking for changes is not one of the automatic attempts.
    draft.planIssues = [];
    draft.currentRunId = await this.dispatchRun(projectId, JobRole.EM, PermissionMode.Plan);
    draft.status = DraftStatus.Planning;
    return draft.save();
  }

  /**
   * Starts the SM backlog-drafting session. Gated: the plan must be approved and every
   * clarification answered (block-planning-until-answered). SM runs Plan→Bypass so it can write
   * backlog.json.
   */
  async startSmBacklog(projectId: string): Promise<DraftDocument> {
    const draft = await this.getDraftByProject(projectId);
    if (!draft.planApproved) {
      throw new BadRequestException('Approve the plan before drafting the backlog.');
    }
    if (!PlanningService.allClarificationsAnswered(draft)) {
      throw new BadRequestException('Answer all clarifications before drafting the backlog.');
    }

    /*
     * A backlog that is already in Azure DevOps cannot be redrafted.
     *
     * Every Scrum Master run *replaces* `draft.backlog` — merging happens only for an automatic
     * correction round — so redrafting throws away each item's `adoId`. The work items stay in
     * Azure DevOps with nothing pointing at them: the board cannot find them, no commit can be
     * traced to a Task, and the dependency lookup that reads `adoId` goes blind.
     *
     * The same trap as re-planning, through a different door. It is guarded here as well because
     * "Start SM backlog" sits beside "Start EM planning" and reads like the smaller, safer of the
     * two — and on a pushed project it is the more destructive.
     */
    const pushed = PlanningService.pushedItemCount(draft);
    if (pushed > 0) {
      throw new BadRequestException(
        `This backlog is already in Azure DevOps (${pushed} work items). Drafting it again would ` +
          'replace every item and lose the link to them, leaving the work items orphaned on the ' +
          'board. To add to a product that has already been planned, start an enhancement ' +
          'instead — it plans on top of what is there and leaves the existing work alone.',
      );
    }
    // Starting a backlog by hand means one of two things, and the draft already says which.
    // With an outstanding change request against an existing backlog, this is the reader asking
    // to **resume** that correction — a run can end without delivering, and there would otherwise
    // be no way back to it except throwing the backlog away. Anything else is a fresh draft.
    const resuming = draft.backlog.length > 0 && Boolean(draft.planFeedback?.trim());
    if (!resuming) {
      draft.planFeedback = null;
      draft.backlogAttempts = 0;
      draft.backlogLastErrors = 0;
    }
    draft.backlogCorrection = false;
    draft.runNote = null;
    draft.currentRunId = await this.dispatchRun(
      projectId,
      JobRole.SM,
      PermissionMode.BypassPermissions,
    );
    draft.status = DraftStatus.BacklogDrafting;
    return draft.save();
  }

  /** SM run reports the backlog; ingested as editable cards (status → BacklogDrafted). */
  /**
   * SM run reports the backlog; ingested, then checked the same way the plan is.
   *
   * Blocking alone is not enough here: a backlog can fail on things a human cannot reasonably
   * repair by hand — thirty Stories arrived with no acceptance criteria at all, and writing
   * thirty sets of criteria is the Scrum Master's job, not the reviewer's. So the orchestrator
   * asks for it again itself, naming what was wrong, exactly as it does for a plan (D-037).
   */
  async ingestBacklog(runId: string, items: DraftDocument['backlog']): Promise<DraftDocument> {
    const draft = await this.findDraftByRun(runId);
    // A correction is merged, not substituted: re-outputting a whole backlog to fix one field
    // is what made each retry silently drop something else.
    // Whether this is a correction is decided by the one thing the agent actually saw: the
    // requested changes. A separate flag could disagree with the prompt — and did, replacing
    // a 64-item backlog with a 5-item patch when the two were reset apart by hand.
    const correcting = Boolean(draft.planFeedback?.trim()) && draft.backlog.length > 0;
    draft.backlog = correcting ? mergeBacklog(draft.backlog, items) : items;
    draft.planFeedback = null; // consumed by this round
    draft.backlogCorrection = false;
    draft.runNote = null;
    draft.status = DraftStatus.BacklogDrafted;

    const project = await this.projects.findById(draft.projectId.toString()).catch(() => null);
    // Validate what the draft now holds, never what just arrived. On a correction `items` is a
    // patch — an id plus the one field being changed — so validating it reported every patched
    // item as missing a title and hid every problem the patch did not touch. The agent was then
    // asked to "fix" titles that were already correct, and the real remaining work went unasked.
    const errors = validateBacklog(draft.backlog, {
      targetRepos: project?.targetRepos ?? [],
      // The plan travels with the backlog so the risks it promised to mitigate can be checked
      // against the work that was actually drafted.
      planMarkdown: draft.planMarkdown,
    }).filter((issue) => issue.severity === 'error');

    // Keep correcting while the *set* of issues keeps changing, and stop when a round returns
    // exactly the same ones — that is what being stuck looks like.
    //
    // Comparing counts was wrong, and wrong in a way that hid itself: the Scrum Master fixes
    // several items a round and routinely trips a different rule doing it (moving a Task's sprint
    // can breach a dependency), so a round that really did make progress came back with the same
    // total and was judged stuck. Because the first two rounds were waved through unconditionally,
    // the check only ever bit on the third — and every product stopped at exactly two attempts out
    // of a budget of eight.
    const signature = PlanningService.errorSignature(errors);
    const stuck = draft.backlogAttempts > 0 && signature === draft.backlogErrorSignature;
    const withinCap = draft.backlogAttempts < PlanningService.MAX_BACKLOG_ATTEMPTS;
    draft.backlogLastErrors = errors.length;
    draft.backlogErrorSignature = signature;
    const improving = !stuck;

    if (errors.length > 0 && improving && withinCap) {
      draft.backlogAttempts += 1;
      draft.backlogCorrection = true;
      draft.planFeedback = PlanningService.backlogFeedbackFor(errors, draft.backlog);
      draft.currentRunId = await this.dispatchRun(
        draft.projectId.toString(),
        JobRole.SM,
        PermissionMode.BypassPermissions,
      );
      draft.status = DraftStatus.BacklogDrafting;
      this.logger.warn(
        `Backlog for project ${draft.projectId.toString()} has ${errors.length} blocking ` +
          `issue(s); regenerating automatically (attempt ${draft.backlogAttempts}).`,
      );
    } else if (errors.length > 0) {
      // Landing in `backlogDrafted` with blocking issues and no explanation reads as "the backlog
      // is ready", and the issues sit in a panel nobody has reason to open.
      draft.runNote = stuck
        ? `The Scrum Master was asked ${draft.backlogAttempts} time(s) to fix ${errors.length} ` +
          'blocking issue(s) and the last round returned exactly the same ones, so it was not ' +
          'asked again. Fix them by hand below, or start the backlog again to try afresh.'
        : `${errors.length} blocking issue(s) remain after ${draft.backlogAttempts} correction ` +
          'round(s), which is the limit. Fix them by hand below, or start the backlog again.';
      this.logger.warn(
        `Backlog for project ${draft.projectId.toString()} left with ${errors.length} blocking ` +
          `issue(s) after ${draft.backlogAttempts} attempt(s); ${stuck ? 'stuck' : 'cap reached'}.`,
      );
    }
    return draft.save();
  }

  /**
   * What an enhancement run needs to know that an initial build does not: that the product exists,
   * which change this is, and what the product already is.
   *
   * The existing plan comes from the project's initial draft rather than from the code, because it
   * says what the product was *meant* to be — the code says what it turned out to be, and the agent
   * reads that too. Null for an initial plan, which is what makes this cost nothing there.
   */
  private async enhancementContext(
    draft: DraftDocument | null,
    projectId: string,
  ): Promise<RunContext['enhancement']> {
    if (!draft || draft.kind !== DraftKind.Enhancement) return null;
    const initial = (await allDrafts(this.draftModel, projectId)).find(
      (d) => d.kind === DraftKind.Initial,
    );
    return {
      ref: enhancementRef(draft.seq),
      title: draft.title ?? '',
      existingPlan: initial?.planMarkdown ?? null,
    };
  }

  /** When a document was created, from the timestamp Mongoose writes. */
  static createdAtOf(doc: { createdAt?: Date | string } | null | undefined): number {
    const at = doc?.createdAt;
    return at ? new Date(at).getTime() : 0;
  }

  /**
   * The repositories a run is given *beside* the one it targets.
   *
   * - **Planning (EM/SM)** targets none, so it gets them all — read-only, to see the application it
   *   is planning changes to. An enhancement cannot be planned against a product nobody has read.
   * - **QA** targets one Story's repository and gets the rest, so a journey that crosses both
   *   applications is testable at all.
   * - **Developer** gets none: one Task, one repository, one commit.
   */
  static reposFor(job: { role: JobRole; repo?: string | null }, targetRepos: string[]): string[] {
    if (job.role === JobRole.EM || job.role === JobRole.SM) return [...targetRepos];
    if (job.role === JobRole.QA) return targetRepos.filter((url) => url !== job.repo);
    return [];
  }

  /** Turns the blocking issues into the correction the Scrum Master is asked to make. */
  /** How many Stories to ask for criteria on in one round. Asking for eighteen produced one. */
  private static readonly CRITERIA_BATCH = 6;

  /**
   * A comparable fingerprint of a set of blocking issues.
   *
   * Sorted, so the order the validator happens to produce them in never changes the answer — two
   * rounds reporting the same problems about the same items must look identical, or the loop would
   * keep going forever against an agent that cannot fix them.
   */
  static errorSignature(errors: ValidationIssue[]): string {
    return errors
      .map((e) => `${e.itemId ?? ''}|${e.message}`)
      .sort()
      .join('\n');
  }

  private static backlogFeedbackFor(
    errors: { itemId: string | null; message: string }[],
    items: DraftDocument['backlog'],
  ): string {
    const titles = new Map(items.map((i) => [i.id, i.title]));
    const describe = (e: { itemId: string | null; message: string }): string => {
      const title = e.itemId ? titles.get(e.itemId) : null;
      return title ? `- ${e.itemId} (${title}): ${e.message}` : `- ${e.message}`;
    };

    // Everything that is not a missing-criteria error is rare, so all of it goes in.
    const isCriteria = (e: { message: string }): boolean =>
      e.message.startsWith('Acceptance criteria are missing');
    const other = errors.filter((e) => !isCriteria(e));
    const criteria = errors.filter(isCriteria);
    const batch = criteria.slice(0, PlanningService.CRITERIA_BATCH);
    const remaining = criteria.length - batch.length;

    return [
      'Do **not** output the whole backlog again. Output **only the corrections**: a JSON array',
      'of objects, each carrying the `id` of the item to fix plus only the fields that need',
      'changing. Anything you leave out keeps the value it already has.',
      '',
      'Fix exactly these and nothing else:',
      '',
      ...other.map(describe),
      ...batch.map(describe),
      '',
      ...(batch.length > 0
        ? [
            `For each of those ${batch.length} Stories, write acceptanceCriteria: one string, one`,
            'condition per line, each starting `- `, each checkable by a tester. Base them on the',
            'Story description and its Tasks.',
          ]
        : []),
      ...(remaining > 0
        ? [
            '',
            `${remaining} further Stories still need criteria; they will be requested next round.`,
            'Do not attempt them now — a short, complete answer is what is wanted.',
          ]
        : []),
    ].join('\n');
  }
}

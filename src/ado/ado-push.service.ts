import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { findActiveDraft } from '../planning/draft-repository';
import { Model } from 'mongoose';
import {
  BacklogItem,
  BacklogItemType,
  Draft,
  DraftDocument,
  DraftKind,
} from '../planning/schemas/draft.schema';
import { ValidationIssue, validateBacklog } from '../planning/backlog-validation';
import { ProjectsService } from '../projects/projects.service';
import { SprintService } from './sprint.service';
import { ApprovalService } from '../approval/approval.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { AdoClientService } from './ado-client.service';
import { inheritedRepo } from './repo-inheritance';
import { describeSprintPlan, newSprintNames, planSprints } from './sprint-anchor';
import { draftLabel } from '../planning/draft-selection';
import { KnowledgeBaseService } from '../knowledge/knowledge-base.service';
import { AdoPushContext } from './ado.types';
import { adoTypeFor, buildCreatePatch, orderParentsFirst } from './draft-to-ado.mapper';
import { describeStates, pickReadyState } from './work-item-states';
import { JsonPatchOperation } from './ado.types';

/**
 * Re-raises a failed create saying which item it was and what was sent.
 *
 * Azure DevOps names neither: "the value 'Approved' is not in the list of supported values" with
 * dozens of creates behind it does not say which item, which type, or even which field value came
 * from us rather than from the process. The status is kept, so a token problem still reads as a
 * token problem rather than a bad request.
 */
export function describeCreateFailure(
  err: unknown,
  adoType: string,
  title: string,
  adoProject: string,
  patch: JsonPatchOperation[],
  ctx?: { storyStateNames?: string | null },
): Error {
  const sentState = patch.find((op) => op.path === '/fields/System.State')?.value;
  const sent = sentState === undefined ? 'no State field' : `State '${String(sentState)}'`;
  const detail = err instanceof Error ? err.message : String(err);
  // Quote the list back when a state we sent was refused: Azure DevOps reporting a state and then
  // rejecting it is the one case nobody believes without seeing both halves at once.
  const reported =
    sentState !== undefined && ctx?.storyStateNames
      ? ` Azure DevOps reported these states for ${adoType}: ${ctx.storyStateNames}.`
      : '';
  const message = `Creating ${adoType} "${title}" in ${adoProject} failed (sent ${sent}). ${detail}${reported}`;
  return err instanceof HttpException
    ? new HttpException(message, err.getStatus())
    : new BadRequestException(message);
}

export interface PushedItem {
  itemId: string;
  adoId: number;
  type: string;
  title: string;
  created: boolean;
}

export interface PushResult {
  created: number;
  skipped: number;
  items: PushedItem[];
}

/**
 * Pushes an approved, target-confirmed draft into Azure DevOps as a work-item hierarchy
 * (Epic → Feature → PBI → Task) under one area path, with states, parent-child links, Developer
 * assignment, per-task repo tag, and sprint. Creation is **idempotent**: each item's ADO id is
 * persisted as it is created, so a retry skips already-created items and only fills gaps. The push
 * is one-directional — ADO is the source of truth afterwards.
 */
/**
 * Sprint order, by the number in the name.
 *
 * Alphabetical puts "Sprint 10" before "Sprint 2", which reads as nonsense in a message listing
 * what is missing. Names with no number in them sort last, in their own order.
 */
function bySprintNumber(a: string, b: string): number {
  const of = (name: string) => {
    const digits = /(\d+)/.exec(name);
    return digits ? Number(digits[1]) : Number.MAX_SAFE_INTEGER;
  };
  return of(a) - of(b) || a.localeCompare(b);
}

@Injectable()
export class AdoPushService {
  private readonly logger = new Logger(AdoPushService.name);

  constructor(
    @InjectModel(Draft.name) private readonly draftModel: Model<DraftDocument>,
    private readonly client: AdoClientService,
    private readonly audit: AuditService,
    private readonly projects: ProjectsService,
    private readonly sprints: SprintService,
    private readonly knowledge: KnowledgeBaseService,
  ) {}

  private get developerAssignee(): string | null {
    return process.env.ADO_DEVELOPER_ASSIGNEE ?? null;
  }

  /**
   * The plan being pushed: the project's active one.
   *
   * A project may now hold an initial plan and its enhancements, and a push creates only the items
   * that have no `adoId` yet — so pushing the active plan adds that cycle's work and leaves every
   * earlier cycle's work items exactly where they are.
   */
  private async getDraft(projectId: string): Promise<DraftDocument> {
    const draft = await findActiveDraft(this.draftModel, projectId);
    if (!draft) {
      throw new NotFoundException('No planning draft for this project.');
    }
    return draft;
  }

  private itemUrl(ctx: AdoPushContext, adoId: number): string {
    return `${ctx.orgUrl.replace(/\/+$/, '')}/_apis/wit/workItems/${adoId}`;
  }

  async push(projectId: string, user: AuthenticatedUser): Promise<PushResult> {
    const draft = await this.getDraft(projectId);
    const ctx = await this.writableContext(draft, projectId);
    const result = await this.createMissing(draft, draft.backlog, ctx);
    await this.markPushed(draft);

    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.AdoPushCompleted,
      entityType: 'draft',
      entityId: draft.id,
      projectId,
      metadata: {
        created: result.created,
        skipped: result.skipped,
        areaPath: ctx.areaPath,
        project: ctx.project,
      },
    });
    this.logger.log(
      `ADO push for project ${projectId}: ${result.created} created, ${result.skipped} skipped.`,
    );
    return result;
  }

  /**
   * Creates a **subset** of the backlog in ADO — the requested items plus every missing ancestor, so
   * the hierarchy is never orphaned. Backs the Development board's "approve for development"
   * action (Draft → To Do), promoting individual Tasks without pushing the whole backlog.
   * Idempotent in the same way as {@link push}: items that already carry an `adoId` are skipped.
   */
  async pushItems(
    projectId: string,
    itemIds: string[],
    user: AuthenticatedUser,
  ): Promise<PushResult> {
    const draft = await this.getDraft(projectId);
    const ctx = await this.writableContext(draft, projectId);
    const subset = AdoPushService.withAncestors(draft.backlog, itemIds);
    const result = await this.createMissing(draft, subset, ctx);
    if (result.created > 0) {
      await this.markPushed(draft);
    }

    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.AdoPushCompleted,
      entityType: 'draft',
      entityId: draft.id,
      projectId,
      metadata: {
        subset: true,
        requestedItems: itemIds.length,
        created: result.created,
        skipped: result.skipped,
        areaPath: ctx.areaPath,
        project: ctx.project,
      },
    });
    return result;
  }

  /**
   * Expands the requested backlog items to include every ancestor (parents must exist in ADO before
   * their children can be linked). Cycle-safe; unknown ids are ignored.
   */
  static withAncestors(backlog: BacklogItem[], itemIds: string[]): BacklogItem[] {
    const byId = new Map(backlog.map((i) => [i.id, i]));
    const wanted = new Set<string>();
    for (const start of itemIds) {
      let cursor: string | null = start;
      while (cursor && byId.has(cursor) && !wanted.has(cursor)) {
        wanted.add(cursor);
        cursor = byId.get(cursor)!.parentId;
      }
    }
    return backlog.filter((i) => wanted.has(i.id));
  }

  /** Names each failing item, so the refusal says what to fix rather than how many things broke. */
  private describe(draft: DraftDocument, issues: ValidationIssue[]): string[] {
    const titles = new Map(draft.backlog.map((i) => [i.id, i.title]));
    return issues.map((issue) => {
      const title = issue.itemId ? titles.get(issue.itemId) : null;
      return title ? `${title} — ${issue.message}` : issue.message;
    });
  }

  /**
   * Every sprint the backlog names must already exist as an iteration, because ADO rejects an
   * unknown one with a bare `TF401347 Invalid tree name` part-way through the push — after some
   * items have already been created. Checked up front instead, and skipped when the iterations
   * cannot be read at all rather than blocking on a transient ADO failure.
   */
  /**
   * Schedules an enhancement onto the sprints the project really has.
   *
   * Its relative Sprint 1 lands on the sprint running now, Sprint 2 on the one after, and so on.
   * Sprints it needs beyond the end are created and subscribed to the team — an iteration that
   * exists but is not on the team's board is as invisible as a closed one, which is the same
   * failure reached a different way.
   *
   * Best-effort on the creating half only: if a sprint cannot be made, the items that would have
   * gone there keep the name they were written with, which is no worse than before and leaves a
   * visible oddity rather than a silent one.
   */
  private async scheduleEnhancement(
    draft: DraftDocument,
    project: string,
    owner: string,
  ): Promise<ReadonlyMap<string, string>> {
    const separator = String.fromCharCode(92); // a literal backslash, built safely
    const leaf = (path: string): string => path.split(separator).pop()!.trim();
    const written = draft.backlog.map((i) => (i.sprint ? leaf(i.sprint) : null));
    let iterations = await this.sprints.listIterations(project, owner).catch(() => []);
    if (iterations.length === 0) return new Map();

    let plan = planSprints(written, iterations, draft.sprintAnchor ?? 'current');
    if (plan.missing.length > 0) {
      const team = await this.sprints.resolveTeamName(project, owner).catch(() => null);
      if (team) {
        for (const name of newSprintNames(iterations, plan.missing.length)) {
          await this.client
            .for(owner)
            .ensureIteration(project, team, name)
            .catch((err: unknown) =>
              this.logger.warn(`Could not create ${name} in ${project}: ${(err as Error).message}`),
            );
        }
        this.sprints.invalidate(project, owner);
        iterations = await this.sprints.listIterations(project, owner).catch(() => iterations);
        plan = planSprints(written, iterations, draft.sprintAnchor ?? 'current');
      }
    }

    this.logger.log(`${draftLabel(draft)} in ${project}: ${describeSprintPlan(plan)}`);
    return plan.mapping;
  }

  /** A plan asking for more than this many new sprints is a planning error, not a schedule. */
  private static readonly MAX_SPRINTS_TO_CREATE = 20;

  /**
   * Makes sure every sprint the backlog names exists, creating the ones that do not.
   *
   * This used to refuse. The reasoning was sound as far as it went — a backlog must never be
   * silently *moved* into a different sprint than it asked for — but it treated a missing sprint as
   * the same kind of problem, and it is not. Azure DevOps gives a new project six sprints; a plan
   * with eight phases of work names Sprint 7 and Sprint 8, which is a perfectly good plan that the
   * project simply has not grown into yet. "Fix these in the backlog" asked a person to edit a plan
   * that was right, to fit a default nobody chose.
   *
   * So the sprints the plan names are created, under the names it used — nothing is moved and
   * nothing is renamed. Refusal is kept for the cases it was meant for: a sprint that cannot be
   * created, and a plan asking for an implausible number of them.
   *
   * An enhancement takes a different path entirely ({@link scheduleEnhancement}): its relative
   * numbering is translated onto the sprints the project already has.
   */
  private async ensureSprintsExist(
    draft: DraftDocument,
    project: string,
    owner: string,
  ): Promise<void> {
    const separator = String.fromCharCode(92);
    const leaf = (path: string): string => path.split(separator).pop()!.trim();
    const named = new Set(
      draft.backlog
        .map((i) => i.sprint?.trim())
        .filter((s): s is string => Boolean(s))
        .map(leaf),
    );
    if (named.size === 0) return;

    const iterations = await this.sprints.listIterations(project, owner).catch(() => []);
    // No readable iterations at all means no team configuration to judge against; the push used to
    // continue in that case and still does, rather than blocking on something it cannot see.
    if (iterations.length === 0) return;

    const known = new Set(iterations.map((i) => leaf(i.path)));
    const missing = [...named].filter((s) => !known.has(s)).sort(bySprintNumber);
    if (missing.length === 0) return;

    if (missing.length > AdoPushService.MAX_SPRINTS_TO_CREATE) {
      throw new BadRequestException({
        message:
          `The backlog targets ${missing.length} sprints this project does not have. That is far ` +
          'more than a plan should need — check the sprint names in the backlog.',
        reason: 'too-many-iterations',
        missingSprints: missing,
        availableSprints: [...known].sort(bySprintNumber),
      });
    }

    const team = await this.sprints.resolveTeamName(project, owner).catch(() => null);
    if (team) {
      for (const name of missing) {
        await this.client
          .for(owner)
          .ensureIteration(project, team, name)
          .catch((err: unknown) =>
            this.logger.warn(`Could not create ${name} in ${project}: ${(err as Error).message}`),
          );
      }
      this.sprints.invalidate(project, owner);
      this.logger.log(`Created ${missing.length} sprint(s) in ${project}: ${missing.join(', ')}.`);
    }

    // Read back rather than assume: a sprint that was not really created must still stop the push,
    // or its work items would be written into an iteration path that does not resolve.
    const after = await this.sprints.listIterations(project, owner).catch(() => iterations);
    const knownNow = new Set(after.map((i) => leaf(i.path)));
    const stillMissing = [...named].filter((s) => !knownNow.has(s)).sort(bySprintNumber);
    if (stillMissing.length > 0) {
      throw new BadRequestException({
        message:
          `${stillMissing.length} sprint(s) could not be created in ${project}. Add them in ` +
          'Azure DevOps, or rename them in the backlog, then push again.',
        reason: 'missing-iterations',
        missingSprints: stillMissing,
        availableSprints: [...knownNow].sort(bySprintNumber),
      });
    }
  }

  /** Pre-write guard + the resolved push target. No ADO write without approval + confirmed target. */
  private async writableContext(draft: DraftDocument, projectId: string): Promise<AdoPushContext> {
    ApprovalService.assertWritable(draft);
    // The project's repositories turn 'this Task names a repo that does not exist' from a
    // silent dead end at execution time into a refusal here.
    const project = await this.projects.findById(projectId).catch(() => null);
    const errors = validateBacklog(draft.backlog, {
      targetRepos: project?.targetRepos ?? [],
      planMarkdown: draft.planMarkdown,
    }).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new BadRequestException({
        message: `Backlog has ${errors.length} validation error(s); cannot push.`,
        reason: 'invalid-backlog',
        errors: this.describe(draft, errors),
      });
    }
    const target = draft.approval.confirmedTarget!;

    /*
     * An enhancement is scheduled; an initial plan is checked.
     *
     * The Scrum Master numbers from one either way. For a first build that is the truth. For an
     * enhancement it is a sprint that closed weeks ago — so its relative order is translated onto
     * the sprints the project actually has, starting from the one running now, and any sprint it
     * still needs is created. An initial plan keeps the old behaviour: the sprints must already
     * exist, and a backlog naming one that does not is refused rather than silently moved.
     */
    const sprintMapping =
      draft.kind === DraftKind.Enhancement
        ? await this.scheduleEnhancement(draft, target.project, projectId)
        : (await this.ensureSprintsExist(draft, target.project, projectId), undefined);

    return {
      owner: projectId,
      orgUrl: target.orgUrl,
      project: target.project,
      areaPath: target.areaPath,
      defaultIterationPath: process.env.ADO_DEFAULT_ITERATION ?? target.project,
      developerAssignee: this.developerAssignee,
      sprintMapping,
      ...(await this.resolveStoryState(target.project, projectId)),
    };
  }

  /**
   * The state a pushed Story should be created in, asked of the project rather than assumed.
   *
   * Resolved once per push: every Story in the backlog is the same work item type, so one request
   * answers for all of them. A failure here is not worth failing a push over — the Story is simply
   * created in its default state and approved in Azure DevOps, which is how this worked before the
   * state was written at all.
   */
  /**
   * Moves a freshly created Story into the project's ready state.
   *
   * A push only happens after a person approved the draft, and that *is* the approval this project
   * asks for. Left in its first state, every Story would need a second, identical approval in
   * Azure DevOps before any of its Tasks could run (the parent-Story gate).
   *
   * Done as a second call rather than in the create patch because Azure DevOps validates the two
   * differently: it reported that a Product Backlog Item supports `New, Approved, Committed, Done,
   * Removed`, then rejected a create carrying `Approved` as "not in the list of supported values".
   * A transition afterwards is the same call the task board makes every day, and it works.
   *
   * A failure here never fails the push: the work item exists, and a Story that needs approving in
   * Azure DevOps is a far better outcome than a backlog half-created.
   */
  private async markStoryReady(adoId: number, title: string, ctx: AdoPushContext): Promise<void> {
    if (!ctx.storyReadyState || !ctx.developerAssignee) return;
    try {
      await this.client
        .for(ctx.owner)
        .setWorkItemState(adoId, ctx.storyReadyState, 'Approved in the orchestrator before push.', {
          // The process rejects a state change whose patch carries no assignee (TF401320).
          'System.AssignedTo': ctx.developerAssignee,
        });
    } catch (err) {
      this.logger.warn(
        `Created "${title}" (#${adoId}) but could not move it to '${ctx.storyReadyState}'; ` +
          `it needs approving in Azure DevOps before its Tasks can run: ${(err as Error).message}`,
      );
    }
  }

  private async resolveStoryState(
    adoProject: string,
    owner: string,
  ): Promise<{ storyReadyState: string | null; storyStateNames: string | null }> {
    const type = adoTypeFor(BacklogItemType.Story);
    try {
      const states = await this.client.for(owner).listWorkItemTypeStates(adoProject, type);
      const names = describeStates(states);
      const ready = pickReadyState(states);
      this.logger.log(`'${type}' in ${adoProject} reports states: ${names}. Using: ${ready}.`);
      if (!ready) {
        this.logger.warn(
          `'${type}' in ${adoProject} has no ready state to create Stories in. Stories will be ` +
            'created in their default state and need approving in Azure DevOps before their ' +
            'Tasks can run.',
        );
      }
      return { storyReadyState: ready, storyStateNames: names };
    } catch (err) {
      this.logger.warn(
        `Could not read the states of '${type}' in ${adoProject}; Stories will be created in ` +
          `their default state: ${(err as Error).message}`,
      );
      return { storyReadyState: null, storyStateNames: null };
    }
  }

  /**
   * Creates the not-yet-pushed items of `items`, parents first. Parent links resolve against the
   * **whole** backlog so a subset push can still attach to an already-created ancestor. Each new id
   * is persisted immediately so a retry never duplicates an item.
   */
  private async createMissing(
    draft: DraftDocument,
    items: BacklogItem[],
    ctx: AdoPushContext,
  ): Promise<PushResult> {
    const byId = new Map(draft.backlog.map((i) => [i.id, i]));
    const ordered = orderParentsFirst(items);
    const result: PushResult = { created: 0, skipped: 0, items: [] };

    for (const item of ordered) {
      if (item.adoId) {
        result.skipped += 1;
        result.items.push({
          itemId: item.id,
          adoId: item.adoId,
          type: adoTypeFor(item.type),
          title: item.title,
          created: false,
        });
        continue;
      }

      const parent = item.parentId ? byId.get(item.parentId) : undefined;
      const parentUrl = parent?.adoId ? this.itemUrl(ctx, parent.adoId) : null;
      // A Story that spans repositories has none of its own; it inherits one from its children so
      // it reaches Azure DevOps with a `repo:` tag QA can resolve (see repo-inheritance.ts).
      const patch = buildCreatePatch(item, ctx, parentUrl, inheritedRepo(item, draft.backlog));
      const adoType = adoTypeFor(item.type);
      // Azure DevOps rejects a field value without saying which item or which field it meant, and
      // a push is dozens of creates — so the one that failed, and what was sent, have to come from
      // here. "the value 'X' is not in the list of supported values" with no item and no type
      // behind it cost a full round of guessing.
      const workItem = await this.client
        .for(ctx.owner)
        .createWorkItem(ctx.project, adoType, patch)
        .catch((err: unknown) => {
          throw describeCreateFailure(err, adoType, item.title, ctx.project, patch, ctx);
        });

      item.adoId = workItem.id;
      draft.markModified('backlog');
      await draft.save(); // persist incrementally so a retry never duplicates this item

      // Only after the id is safely recorded: the item exists in Azure DevOps from the moment the
      // create returned, so anything that could still throw has to come after the id is written,
      // or a retry would create the same work item twice.
      if (item.type === BacklogItemType.Story) {
        await this.markStoryReady(workItem.id, item.title, ctx);
      }

      result.created += 1;
      result.items.push({
        itemId: item.id,
        adoId: workItem.id,
        type: adoTypeFor(item.type),
        title: item.title,
        created: true,
      });
    }
    return result;
  }

  /**
   * Writes the plan into the project's knowledge base, the first time it is pushed.
   *
   * The plan is the best description of the product that exists at this moment, and until now it
   * was read once by the Scrum Master and never again. Seeding here means the first Developer run
   * starts knowing what the product is, rather than reading the whole codebase to find out — which
   * is how run #898 spent a million tokens and was killed before it could commit.
   *
   * Never overwrites, and never fails the push: this is a document written beside the work, not
   * part of it.
   */
  private async seedKnowledgeBase(draft: DraftDocument, projectId: string): Promise<void> {
    try {
      if (await this.knowledge.seedFromPlan(projectId, draft.planMarkdown)) {
        this.logger.log(`Knowledge base seeded from the plan for ${projectId}.`);
      }
    } catch (err) {
      this.logger.warn(`Could not seed the knowledge base: ${(err as Error).message}`);
    }
  }

  private async markPushed(draft: DraftDocument): Promise<void> {
    await this.seedKnowledgeBase(draft, draft.projectId.toString());
    draft.approval.pushedToAdo = true;
    draft.approval.pushedAt = new Date();
    await draft.save();
  }
}

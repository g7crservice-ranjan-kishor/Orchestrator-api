import { Injectable, Logger } from '@nestjs/common';
import { AdoClientService } from '../ado/ado-client.service';
import { childCandidates, storyCandidates } from './story-links';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { ProjectsService } from '../projects/projects.service';
import { QA_VERIFIED_TAG, hasQaVerifiedTag } from '../qa/qa-workflow';
import {
  RollupSkipReason,
  StoryChild,
  decideStoryCompletion,
  decideStoryStart,
} from './story-rollup';

const CHILD_FIELDS = ['System.WorkItemType', 'System.State', 'System.Parent'];
const STORY_FIELDS = [...CHILD_FIELDS, 'System.AssignedTo', 'System.Tags'];

/**
 * Moves a **Story** as its Tasks move (D-028).
 *
 * Azure DevOps does not roll a parent up on its own, and nothing else in the orchestrator ever
 * writes a Story's state — so before this existed a Story stayed `Approved` forever while its Tasks
 * were completed and pushed, and **no Story ever became Ready for QA**. Two transitions:
 *
 * - first Task starts → Story `New`/`Approved` → **Committed** (development under way)
 * - last Task completes → Story → **Done**, which *is* the Ready-for-QA signal the QA agent reads
 *
 * Both are **orchestrator-owned and best-effort**: a failure is logged and audited but never breaks
 * the Task transition or the run-event ingest that triggered it. Azure DevOps stays the source of
 * truth — the state is written there, never mirrored locally.
 */
@Injectable()
export class StoryRollupService {
  private readonly logger = new Logger(StoryRollupService.name);

  constructor(
    private readonly ado: AdoClientService,
    private readonly projects: ProjectsService,
    private readonly audit: AuditService,
  ) {}

  /** Story `New`/`Approved` → `Committed` when development starts on one of its Tasks. */
  async onTaskStarted(projectId: string | null, taskAdoId: number): Promise<void> {
    await this.apply(projectId, taskAdoId, 'started');
  }

  /** Story → `Done` (Ready for QA) once every Task is Done and no linked Bug is open. */
  async onTaskCompleted(projectId: string | null, taskAdoId: number): Promise<void> {
    await this.apply(projectId, taskAdoId, 'completed');
  }

  /**
   * Shared path: resolve the parent Story, ask the pure rules what should happen, and write it.
   * Never throws — the caller is mid-transition (or mid-ingest) and a rollup failure must not undo
   * work that already succeeded.
   */
  private async apply(
    projectId: string | null,
    taskAdoId: number,
    trigger: 'started' | 'completed',
  ): Promise<void> {
    try {
      const story = await this.parentStoryOf(taskAdoId, projectId);
      if (!story) {
        return; // a Task with no parent Story has nothing to roll up
      }
      const decision =
        trigger === 'started'
          ? decideStoryStart(story.state)
          : decideStoryCompletion(
              story.state,
              await this.childrenOf(story.id, await this.adoProject(projectId), projectId),
            );

      if (!decision.promote) {
        this.logSkip(story.id, trigger, decision.reason);
        return;
      }

      await this.ado
        .for(projectId)
        .setWorkItemState(story.id, decision.to, this.commentFor(decision.to), {
          ...this.requiredFieldsFor(story.assignee),
          // Reopening for development invalidates any previous QA pass, so the `qa-verified` tag is
          // dropped (D-025/D-028) — otherwise the changed Story would never be tested again.
          ...(decision.to === 'Committed' ? this.clearedVerifiedTag(story.tags) : {}),
        });
      this.logger.log(`Story ${story.id}: ${story.state} → ${decision.to} (Task ${taskAdoId}).`);
      await this.audit.append({
        actor: AuditService.actorFrom(null), // orchestrator, not a user
        action:
          decision.to === 'Done'
            ? AuditAction.StoryReadyForQa
            : AuditAction.StoryDevelopmentStarted,
        entityType: 'story',
        entityId: String(story.id),
        projectId,
        metadata: { from: story.state, to: decision.to, triggeredByTask: taskAdoId },
      });
    } catch (err) {
      // Best-effort by design: the Task transition already succeeded and must stand.
      this.logger.error(
        `Story rollup failed for Task ${taskAdoId} (${trigger}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Fields the Story transition must carry to satisfy this project's process rules. Scrum here makes
   * **Assigned To** required to leave `Approved`, so an unassigned Story is given the configured
   * developer identity **in the same patch** — ADO rejects the state change otherwise (`TF401320`).
   * An existing assignee is never overwritten.
   */
  private requiredFieldsFor(currentAssignee: string | null): Record<string, unknown> {
    const fallback = process.env.ADO_DEVELOPER_ASSIGNEE?.trim();
    if (currentAssignee || !fallback) {
      return {};
    }
    return { 'System.AssignedTo': fallback };
  }

  /**
   * The Story's tags with `qa-verified` removed, or `{}` when it was not tagged. Returned as a field
   * patch so the tag change rides along with the state change in a single update.
   */
  private clearedVerifiedTag(tags: string | null): Record<string, unknown> {
    if (!hasQaVerifiedTag(tags)) {
      return {};
    }
    const remaining = (tags ?? '')
      .split(';')
      .map((t) => t.trim())
      .filter((t) => t && t.toLowerCase() !== QA_VERIFIED_TAG);
    return { 'System.Tags': remaining.join('; ') };
  }

  /** `System.AssignedTo` is an identity object in REST 7.0 (a plain string on older payloads). */
  private static identityName(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    const id = value as { displayName?: string; uniqueName?: string };
    return id.uniqueName?.trim() || id.displayName?.trim() || null;
  }

  private commentFor(state: string): string {
    return state === 'Done'
      ? 'All Tasks are Done — development complete, Ready for QA (set by the orchestrator).'
      : 'Development started on this Story (set by the orchestrator).';
  }

  private logSkip(storyId: number, trigger: string, reason: RollupSkipReason): void {
    this.logger.debug?.(`Story ${storyId} not moved on Task ${trigger}: ${reason}.`);
  }

  /** The Task's parent Story (`System.Parent`), with its current state. */
  private async parentStoryOf(
    taskAdoId: number,
    owner: string | null,
  ): Promise<{ id: number; state: string; assignee: string | null; tags: string | null } | null> {
    const ado = this.ado.for(owner);
    const [task] = await ado.getWorkItemsBatch([taskAdoId], CHILD_FIELDS);
    const field = task?.fields['System.Parent'];
    let parentId = typeof field === 'number' ? field : null;

    /*
     * No parent field: look at the links before giving up.
     *
     * QA was told to link a Bug to its Story "(parent/related)", and for four Bugs it chose
     * **related** — which is what it had been allowed to do. `System.Parent` is empty for those, so
     * the Story was never found, never rolled up, and never re-tested: Story 740 sat in `Committed`
     * with its Bug fixed and Done, waiting for a request nothing would make.
     */
    if (parentId === null) {
      const [links] = await ado.getWorkItemRelations([taskAdoId]);
      parentId = storyCandidates(links?.relations ?? [])[0] ?? null;
    }
    if (parentId === null) {
      return null;
    }
    const [story] = await ado.getWorkItemsBatch([parentId], STORY_FIELDS);
    if (!story) {
      return null;
    }
    return {
      id: parentId,
      state: String(story.fields['System.State'] ?? ''),
      assignee: StoryRollupService.identityName(story.fields['System.AssignedTo']),
      tags: story.fields['System.Tags'] ? String(story.fields['System.Tags']) : null,
    };
  }

  /** Every work item parented to the Story — its Tasks, and any Bug QA filed against it. */
  private async childrenOf(
    storyId: number,
    project: string | null,
    owner: string | null,
  ): Promise<StoryChild[]> {
    if (!project) {
      return [];
    }
    const parented = await this.ado
      .for(owner)
      .queryWorkItemIds(
        project,
        `SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ${storyId}`,
      );

    /*
     * Plus anything merely *related* to the Story.
     *
     * The query above finds only what hangs off the Story. A Bug QA linked as related is still a
     * Bug against this Story, and an open one still means it is not finished — without this the
     * Story would be declared Ready for QA with a defect outstanding against it.
     */
    const [links] = await this.ado.for(owner).getWorkItemRelations([storyId]);
    const ids = [...new Set([...parented, ...childCandidates(links?.relations ?? [])])];
    if (ids.length === 0) {
      return [];
    }
    const items = await this.ado.for(owner).getWorkItemsBatch(ids, CHILD_FIELDS);
    return items.map((wi) => ({
      id: wi.id,
      type: String(wi.fields['System.WorkItemType'] ?? ''),
      state: String(wi.fields['System.State'] ?? ''),
    }));
  }

  /**
   * The ADO project whose work items to query — the orchestrator project's own `adoTarget`, falling
   * back to the configured default when the project cannot be read (the rollup is best-effort and
   * must not fail just because the project lookup did).
   */
  private async adoProject(projectId: string | null): Promise<string | null> {
    if (projectId) {
      try {
        const project = await this.projects.findById(projectId);
        if (project.adoTarget?.project) {
          return project.adoTarget.project;
        }
      } catch {
        // fall through to the configured default
      }
    }
    return process.env.ADO_PROJECT?.trim() || null;
  }
}

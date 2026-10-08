import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AdoClientService, AdoIteration } from './ado-client.service';
import { AdoBoardService, BoardTask } from './ado-board.service';
import { SprintService } from './sprint.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { ProjectsService } from '../projects/projects.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/** Default sprint length used only when neither the next nor the current sprint has dates to copy. */
export const DEFAULT_SPRINT_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One sprint as the rollover sees it. */
export interface SprintSummary {
  name: string;
  path: string;
  startDate: string | null;
  finishDate: string | null;
}

/** A Task that will not be finished when the sprint closes. */
export interface CarryOverTask {
  adoId: number | null;
  key: string;
  title: string;
  status: string;
}

/**
 * What closing the current sprint would do. Returned by the dry run (the confirmation dialog) and,
 * unchanged in shape, by the real thing — so the user confirms exactly what gets applied.
 */
export interface SprintRolloverPlan {
  /** False when a blocker makes the rollover impossible; `blockers` says why. */
  ok: boolean;
  dryRun: boolean;
  /** True once the dates have actually been written to Azure DevOps. */
  applied: boolean;
  current: SprintSummary | null;
  next: SprintSummary | null;
  /** The dates that will be (or were) written. */
  /** The closing sprint's start, moved back only when it would otherwise outlast its finish. */
  newCurrentStart: string | null;
  newCurrentFinish: string | null;
  newNextStart: string | null;
  newNextFinish: string | null;
  /** Hard stops — the rollover cannot proceed. */
  blockers: string[];
  /** Tasks in the closing sprint that are not Done. Any of these blocks the rollover. */
  carryOver: CarryOverTask[];
}

/** Midnight UTC for `date` — ADO stores iteration bounds as whole days. */
function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed);
}

/** Whole days an iteration spans, inclusive of both bounds; null when it is not fully dated. */
function lengthInDays(iteration: SprintSummary | null): number | null {
  const start = parseDate(iteration?.startDate ?? null);
  const finish = parseDate(iteration?.finishDate ?? null);
  if (!start || !finish) return null;
  return Math.round((finish.getTime() - start.getTime()) / DAY_MS) + 1;
}

/**
 * Computes the new calendar for a rollover: the current sprint ends **yesterday** (so ADO
 * reclassifies it as `past` today) and the next sprint starts **today** (so ADO reports it as
 * `current` immediately). The next sprint keeps its own configured length when it has one,
 * otherwise it inherits the closing sprint's length, otherwise {@link DEFAULT_SPRINT_DAYS}.
 *
 * **A sprint that began today can still be closed today.** Moving only its finish date back would
 * put the finish before the start, which Azure DevOps rejects, and pulling the next sprint's start
 * to today instead makes the two overlap — at which point ADO keeps the earlier one as `current`
 * and the new sprint reports `future`. The answer is to move the closing sprint's **start** back as
 * well, so it becomes a valid one-day sprint sitting entirely in the past: no overlap, nothing
 * inverted, and the next sprint is current immediately. This is what lets several sprints be run
 * through in a single day.
 *
 * The cost is honest and small: the closed sprint no longer records the day it actually began.
 * Rewriting these dates is already the whole mechanism — ADO derives `current` from nothing else.
 */
export function planRolloverDates(
  current: SprintSummary,
  next: SprintSummary,
  now: Date,
): { currentStart: string; currentFinish: string; nextStart: string; nextFinish: string } {
  const today = startOfDay(now);
  const yesterday = addDays(today, -1);
  const originalStart = parseDate(current.startDate);
  // A sprint that has not begun yet, or began today, is compressed into yesterday entirely.
  const startsInThePast = originalStart !== null && originalStart.getTime() < today.getTime();
  const currentStart = startsInThePast ? originalStart : yesterday;
  const currentFinish = yesterday;
  const nextStart = today;
  const days = lengthInDays(next) ?? lengthInDays(current) ?? DEFAULT_SPRINT_DAYS;
  const nextFinish = addDays(nextStart, Math.max(days, 1) - 1);
  return {
    currentStart: currentStart.toISOString(),
    currentFinish: currentFinish.toISOString(),
    nextStart: nextStart.toISOString(),
    nextFinish: nextFinish.toISOString(),
  };
}

/** The iteration that follows `current` in ADO's backlog order, if the project defines one. */
export function findNextIteration(
  iterations: readonly AdoIteration[],
  currentPath: string,
): AdoIteration | null {
  const index = iterations.findIndex((i) => i.path === currentPath);
  if (index < 0) return null;
  return iterations[index + 1] ?? null;
}

const toSummary = (i: AdoIteration): SprintSummary => ({
  name: i.name,
  path: i.path,
  startDate: i.startDate,
  finishDate: i.finishDate,
});

/**
 * **Sprint rollover**: closes the active sprint and starts the next one.
 *
 * Azure DevOps derives `timeFrame` (past/current/future) purely from iteration **dates** — never
 * from whether the work inside is finished. So a team that completes its sprint early stays stuck on
 * it, and the board's future-sprint rule blocks the next sprint's Tasks until the calendar catches
 * up. This service does what a human would otherwise do by hand in Project configuration: it moves
 * the two dates, in ADO, so ADO remains the single source of truth for which sprint is active
 * (ARCHITECTURE.md §8). Nothing about sprints is mirrored or inferred locally.
 *
 * Every rollover is validated first and recorded in the immutable audit trail.
 */
@Injectable()
export class SprintRolloverService {
  private readonly logger = new Logger(SprintRolloverService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly sprints: SprintService,
    private readonly board: AdoBoardService,
    private readonly client: AdoClientService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Validates the rollover and, unless `dryRun`, applies it. The dry run backs the confirmation
   * dialog: it reports the exact dates that would be written and which Tasks would carry over,
   * without touching Azure DevOps.
   */
  async completeCurrentSprint(
    projectId: string,
    user: AuthenticatedUser,
    opts: { dryRun?: boolean } = {},
  ): Promise<SprintRolloverPlan> {
    const dryRun = Boolean(opts.dryRun);
    const project = await this.projects.findById(projectId);
    const adoProject = project.adoTarget?.project;
    if (!adoProject) {
      throw new BadRequestException('This project has no Azure DevOps target configured.');
    }

    const iterations = await this.sprints.listIterations(adoProject, projectId);
    const currentIteration = iterations.find((i) => i.timeFrame === 'current') ?? null;
    const nextIteration = currentIteration
      ? findNextIteration(iterations, currentIteration.path)
      : null;

    const plan = await this.buildPlan(projectId, currentIteration, nextIteration, dryRun);
    if (!plan.ok || dryRun) {
      return plan;
    }

    await this.client
      .for(projectId)
      .updateIterationDates(
        adoProject,
        plan.current!.path,
        plan.newCurrentStart!,
        plan.newCurrentFinish!,
      );
    await this.client
      .for(projectId)
      .updateIterationDates(adoProject, plan.next!.path, plan.newNextStart!, plan.newNextFinish!);
    /*
     * The board must show the new active sprint at once, not after the cache TTL.
     *
     * The owner is not optional here. `SprintService` keys its cache by organization *and* project
     * (`<owner>::<adoProject>`), because two orchestrator projects can name the same Azure DevOps
     * project in different organizations. The board reads with the owner; clearing without one
     * dropped a `platform::` entry nobody had written, left the board's own entry in place, and the
     * badge kept reporting the sprint that had just been closed until the 5-minute TTL expired.
     */
    this.sprints.invalidate(adoProject, projectId);
    this.logger.log(
      `Sprint rollover for ${adoProject}: ${plan.current!.name} closed, ${plan.next!.name} started.`,
    );

    await this.audit.append({
      actor: AuditService.actorFrom(user),
      action: AuditAction.SprintCompleted,
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: {
        adoProject,
        closed: { sprint: plan.current!.name, finishDate: plan.newCurrentFinish },
        started: {
          sprint: plan.next!.name,
          startDate: plan.newNextStart,
          finishDate: plan.newNextFinish,
        },
        carryOver: plan.carryOver,
        carriedOver: plan.carryOver.length,
      },
    });

    return { ...plan, applied: true };
  }

  /** Runs every validation and computes the new dates; never writes. */
  private async buildPlan(
    projectId: string,
    currentIteration: AdoIteration | null,
    nextIteration: AdoIteration | null,
    dryRun: boolean,
  ): Promise<SprintRolloverPlan> {
    const blockers: string[] = [];

    if (!currentIteration) {
      blockers.push(
        'Azure DevOps reports no active sprint for this project. Set start and finish dates on an iteration first.',
      );
    }
    if (currentIteration && !nextIteration) {
      blockers.push(
        `There is no sprint after ${currentIteration.name} in Azure DevOps. Create the next iteration before closing this one.`,
      );
    }

    const current = currentIteration ? toSummary(currentIteration) : null;
    const next = nextIteration ? toSummary(nextIteration) : null;

    // Carry-over and running-agent checks need the board's own view of the sprint's Tasks.
    const carryOver: CarryOverTask[] = [];
    if (current) {
      const tasks = await this.tasksInSprint(projectId, current.name);
      const running = tasks.filter((t) => t.agentRunning);
      if (running.length > 0) {
        blockers.push(
          `A Developer agent is still running on ${running
            .map((t) => `#${t.adoId ?? t.key}`)
            .join(', ')}. Wait for the run to finish before closing the sprint.`,
        );
      }
      for (const task of tasks.filter((t) => t.status !== 'Done')) {
        carryOver.push({
          adoId: task.adoId,
          key: task.key,
          title: task.title,
          status: task.status,
        });
      }
      // A sprint is only closable when its work is actually finished: the rollover is a deliberate
      // "this sprint is complete" statement, not a way to sweep unfinished Tasks forward.
      if (carryOver.length > 0) {
        blockers.push(
          `${current.name} still has ${carryOver.length} Task${
            carryOver.length === 1 ? '' : 's'
          } that ${carryOver.length === 1 ? 'is' : 'are'} not Done. Finish ${
            carryOver.length === 1 ? 'it' : 'them'
          } before closing the sprint.`,
        );
      }
    }

    const ok = blockers.length === 0;
    const dates = ok && current && next ? planRolloverDates(current, next, new Date()) : null;

    return {
      ok,
      dryRun,
      applied: false,
      current,
      next,
      newCurrentStart: dates?.currentStart ?? null,
      newCurrentFinish: dates?.currentFinish ?? null,
      newNextStart: dates?.nextStart ?? null,
      newNextFinish: dates?.nextFinish ?? null,
      blockers,
      carryOver,
    };
  }

  /** The board's Tasks that belong to `sprintName` (board projection, so statuses are normalized). */
  private async tasksInSprint(projectId: string, sprintName: string): Promise<BoardTask[]> {
    const board = await this.board.getBoard(projectId);
    return board.columns.flatMap((c) => c.tasks).filter((t) => t.sprint === sprintName);
  }
}

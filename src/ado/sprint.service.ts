import { Injectable, Logger } from '@nestjs/common';
import { AdoClientService, AdoIteration } from './ado-client.service';

/** Where an iteration sits relative to today, as classified by Azure DevOps itself. */
export type SprintTimeFrame = 'past' | 'current' | 'future' | 'unknown';

/** The sprint picture for one project: which iteration is active, and how each one classifies. */
export interface SprintContext {
  /** Name of the active sprint (e.g. `Sprint 1`), or null when ADO cannot determine one. */
  currentSprint: string | null;
  /** Normalised iteration path → time frame. */
  frames: ReadonlyMap<string, SprintTimeFrame>;
}

/** Iteration paths differ in case/separator between APIs; compare on a normalised form. */
export function normalizeIterationPath(path: string | null | undefined): string {
  return (path ?? '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY: SprintContext = { currentSprint: null, frames: new Map() };

/**
 * Resolves which sprint is **active** for a project, straight from the Azure DevOps team iteration
 * configuration (`attributes.timeFrame` = past/current/future). Sprint names are never hardcoded and
 * dates are never inferred — ADO is the source of truth (a project whose iterations carry no dates
 * simply reports `unknown`, and the sprint rule then does not block anything).
 *
 * Results are cached briefly so a board load does not re-query ADO for every Task.
 */
@Injectable()
export class SprintService {
  private readonly logger = new Logger(SprintService.name);
  private readonly cache = new Map<string, { at: number; context: SprintContext }>();

  constructor(private readonly client: AdoClientService) {}

  /**
   * The active sprint + iteration classification for `project`. Degrades to empty on any failure.
   *
   * `owner` is the orchestrator project whose Azure DevOps credentials to speak with. It is also
   * part of the cache key: two orchestrator projects can name the same ADO project in different
   * organizations, and serving one of them the other's sprints would be silently wrong.
   */
  async getContext(project: string, owner?: string | null): Promise<SprintContext> {
    const key = SprintService.cacheKey(project, owner);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.context;
    }
    try {
      const iterations = await this.listIterations(project, owner);
      if (iterations.length === 0) return EMPTY;
      const frames = new Map<string, SprintTimeFrame>();
      let currentSprint: string | null = null;
      for (const it of iterations) {
        const frame = SprintService.toTimeFrame(it.timeFrame);
        frames.set(normalizeIterationPath(it.path), frame);
        if (frame === 'current' && !currentSprint) currentSprint = it.name;
      }
      const context: SprintContext = { currentSprint, frames };
      this.cache.set(key, { at: Date.now(), context });
      return context;
    } catch (err) {
      // Sprint data is an eligibility input, not a hard dependency — never break the board over it.
      this.logger.warn(
        `Could not read sprint configuration for ${project}: ${(err as Error).message}`,
      );
      return EMPTY;
    }
  }

  /**
   * The team's iterations **in ADO's own backlog order**, with their dates and classification.
   * Uncached: the sprint-rollover flow must decide on live data, and it also reads the dates, which
   * the cached {@link SprintContext} deliberately does not carry.
   */
  async listIterations(project: string, owner?: string | null): Promise<AdoIteration[]> {
    const team = await this.resolveTeam(project, owner);
    if (!team) return [];
    return this.client.for(owner).listTeamIterations(project, team);
  }

  /**
   * Drops the cached sprint picture for `project`. Called after the orchestrator changes iteration
   * dates (sprint rollover) so the board reflects the new active sprint immediately instead of
   * serving a stale classification for up to {@link CACHE_TTL_MS}.
   */
  invalidate(project: string, owner?: string | null): void {
    this.cache.delete(SprintService.cacheKey(project, owner));
  }

  /** Sprints are cached per organization as well as per project — see {@link getContext}. */
  private static cacheKey(project: string, owner?: string | null): string {
    return `${owner ?? 'platform'}::${project}`;
  }

  /**
   * Classifies a work item's iteration path. `unknown` when the path is empty or the project's
   * iterations could not be read — callers treat unknown as "do not block".
   */
  static classify(iterationPath: string | null, context: SprintContext): SprintTimeFrame {
    const key = normalizeIterationPath(iterationPath);
    if (!key || context.frames.size === 0) return 'unknown';
    return context.frames.get(key) ?? 'unknown';
  }

  /**
   * The team whose iterations a project's sprints belong to.
   *
   * Public because creating a sprint needs it twice over: an iteration has to be made under the
   * project *and* subscribed to the team, or it exists while being invisible on every board.
   */
  async resolveTeamName(project: string, owner?: string | null): Promise<string | null> {
    return this.resolveTeam(project, owner);
  }

  /** Team from `ADO_TEAM`, else the project's default (first) team. */
  private async resolveTeam(project: string, owner?: string | null): Promise<string | null> {
    const configured = process.env.ADO_TEAM?.trim();
    if (configured) return configured;
    const teams = await this.client.for(owner).listTeams(project);
    return teams[0]?.name ?? null;
  }

  private static toTimeFrame(raw: string): SprintTimeFrame {
    switch (raw) {
      case 'past':
      case 'current':
      case 'future':
        return raw;
      default:
        return 'unknown';
    }
  }
}

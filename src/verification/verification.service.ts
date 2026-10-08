import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JobsService } from '../jobs/jobs.service';
import { JobDispatchService } from '../jobs/job-dispatch.service';
import { JobRole, JobState, PermissionMode } from '../jobs/job-state';
import { ProjectsService } from '../projects/projects.service';

/** What a verification run reports back to the board. */
export interface VerificationView {
  runId: string | null;
  state: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The full check report from the pod; null until the run finishes. */
  report: string | null;
  passed: boolean | null;
}

/**
 * Starts and reports the product verification — the only gate that ever sees the whole product.
 *
 * Every other gate judges one repository in isolation. Unit tests mock the API, so the mock returns
 * whatever the interface already believes. API tests have no interface. A QA agent asked to verify
 * "end to end" reaches for `curl`, which never sends an `Origin` header and never renders a page.
 * All of them were green while the last product could not serve a single request from its own UI.
 *
 * This run starts the product and reads what comes back. It uses no agent and no tokens, so its
 * verdict is a fact rather than an opinion — and it is the one thing that can make §21 of the
 * delivery standard ("verify the actual user flow") true rather than merely asked for.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly dispatcher: JobDispatchService,
    private readonly projects: ProjectsService,
  ) {}

  /** Starts a verification run for the project, or returns the one already in flight. */
  async start(projectId: string): Promise<VerificationView> {
    const project = await this.projects.findById(projectId); // 404 if unknown
    const repos = project.targetRepos ?? [];
    if (repos.length === 0) {
      throw new BadRequestException(
        'This project targets no repositories, so there is no product to verify.',
      );
    }

    const active = await this.latest(projectId);
    if (active.runId && active.state && !VerificationService.isTerminal(active.state)) {
      return active; // idempotent: re-clicking must not start a second pod
    }

    const job = await this.jobs.enqueue({
      runId: randomUUID(),
      role: JobRole.Verify,
      projectId,
      // The first repository is the working checkout; the rest arrive as companions, exactly as
      // they do for QA. Which one is the API is decided in the pod, from what each contains.
      repo: repos[0],
      permissionMode: PermissionMode.BypassPermissions,
    });

    try {
      await this.dispatcher.dispatch(job);
    } catch (err) {
      this.logger.warn(
        `Execution backend unavailable for verification ${job.runId}; job left Queued: ${
          (err as Error).message
        }`,
      );
    }
    return this.latest(projectId);
  }

  /** The most recent verification for the project, running or finished. */
  async latest(projectId: string): Promise<VerificationView> {
    const runs = await this.jobs.listForProject(projectId);
    const job = runs.find((j) => j.role === JobRole.Verify);
    if (!job) {
      return {
        runId: null,
        state: null,
        startedAt: null,
        finishedAt: null,
        report: null,
        passed: null,
      };
    }
    const finished = VerificationService.isTerminal(job.state);
    return {
      runId: job.runId,
      state: job.state,
      // Mongoose adds these via `timestamps`; they are not on the schema class.
      startedAt: (job as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? null,
      finishedAt: finished
        ? ((job as unknown as { updatedAt?: Date }).updatedAt?.toISOString() ?? null)
        : null,
      report: job.result?.output ?? null,
      passed: finished ? job.state === JobState.Completed : null,
    };
  }

  private static isTerminal(state: string): boolean {
    return (
      state === JobState.Completed || state === JobState.Failed || state === JobState.Cancelled
    );
  }
}

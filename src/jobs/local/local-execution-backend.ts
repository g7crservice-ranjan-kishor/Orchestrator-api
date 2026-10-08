import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { AppConfigService } from '../../common/config/app-config.service';
import { JobDocument } from '../schemas/job.schema';
import { ExecutionBackend, JobDispatchContext } from '../execution-backend';

/**
 * Runs the Agent Runner as a local child process instead of a Kubernetes Job — for single-box
 * dev/demo without a cluster (select with `EXECUTION_BACKEND=local`). Same contract as
 * {@link AKSExecutionBackend}: one process per run; the process authenticates back to the Runner
 * API with its per-run token and posts events + plan/backlog. Prompt composition and the model call
 * happen inside the worker, exactly as in the pod.
 *
 * Requires the worker to be built (`npm run build --workspace worker`) and the `claude` CLI to be
 * installed + authenticated (subscription) or `ANTHROPIC_API_KEY` set (api mode).
 */
@Injectable()
export class LocalExecutionBackend implements ExecutionBackend {
  private readonly logger = new Logger(LocalExecutionBackend.name);
  private readonly running = new Map<string, ChildProcess>();

  constructor(private readonly config: AppConfigService) {}

  /** Absolute path to the compiled worker entrypoint (override with WORKER_ENTRY). */
  private workerEntry(): string {
    return process.env.WORKER_ENTRY
      ? resolve(process.env.WORKER_ENTRY)
      : resolve(process.cwd(), 'apps', 'worker', 'dist', 'entrypoint.js');
  }

  async startRun(job: JobDocument, ctx: JobDispatchContext): Promise<void> {
    const workspaceDir = join(tmpdir(), `aijob-${job.runId}`);
    mkdirSync(workspaceDir, { recursive: true });

    const args = [
      this.workerEntry(),
      `--run-id=${job.runId}`,
      `--role=${job.role}`,
      `--project=${job.projectId.toString()}`,
      `--permission-mode=${job.permissionMode}`,
    ];
    if (job.workItemId) args.push(`--work-item=${job.workItemId}`);
    if (job.repo) args.push(`--repo=${job.repo}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BACKEND_EVENTS_URL: ctx.backendEventsUrl,
      RUN_TOKEN: ctx.perRunToken,
      CLAUDE_AUTH_MODE: ctx.claudeAuthMode,
      MAX_TOKENS: String(this.config.maxRunTokens),
      WORKSPACE_DIR: workspaceDir,
    };
    if (process.env.WORKER_TEMPLATES_DIR) {
      env.TEMPLATES_DIR = resolve(process.env.WORKER_TEMPLATES_DIR);
    }

    const child = spawn(process.execPath, args, { env, stdio: 'ignore' });
    this.running.set(job.runId, child);
    child.on('exit', (code) => {
      this.running.delete(job.runId);
      this.logger.log(`Local runner for ${job.runId} exited with code ${code ?? 'null'}.`);
    });
    child.on('error', (err) => {
      this.running.delete(job.runId);
      this.logger.error(`Local runner for ${job.runId} failed to start: ${err.message}`);
    });
    child.unref();
    this.logger.log(`Started local runner for ${job.runId} (role=${job.role}, pid=${child.pid}).`);
  }

  async cancel(runId: string): Promise<void> {
    const child = this.running.get(runId);
    if (child) {
      child.kill('SIGTERM');
      this.running.delete(runId);
      this.logger.log(`Cancelled local runner for ${runId}.`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { BatchV1Api, KubeConfig, loadYaml, V1EnvVar, V1Job } from '@kubernetes/client-node';
import { AppConfigService } from '../../common/config/app-config.service';
import { JobRole } from '../job-state';
import { JobDocument } from '../schemas/job.schema';
import {
  ExecutionBackend,
  ExecutionOverlayContext,
  JobDispatchContext,
} from '../execution-backend';
import { JOB_TEMPLATE_YAML } from './job-template';
import { JOB_TEMPLATE_LOCAL_YAML } from './local-job-template';

// Re-export so existing importers (and the spec) keep resolving the type from here.
export type { JobDispatchContext } from '../execution-backend';

/** How long to wait for a deleted Job to disappear before giving up: 20 x 500ms = 10s. */
export const JOB_DELETE_POLLS = 20;
export const JOB_DELETE_POLL_MS = 500;

/**
 * ExecutionBackend seam for AKS. Single responsibility (ARCHITECTURE.md §3): render the Job
 * template and create exactly one Kubernetes Job per AI job; cancel by deleting that Job. It does
 * not compose prompts, run the model, or touch ADO/git — all of that happens in the pod. The K8s
 * client is created lazily (in-cluster config, or local kubeconfig) so the class is usable in
 * tests without a cluster.
 */
@Injectable()
export class AKSExecutionBackend implements ExecutionBackend {
  private readonly logger = new Logger(AKSExecutionBackend.name);
  private batch?: BatchV1Api;

  constructor(private readonly config: AppConfigService) {}

  /** Overrides the K8s client (used in tests). */
  setBatchApi(api: BatchV1Api): void {
    this.batch = api;
  }

  private getBatch(): BatchV1Api {
    if (!this.batch) {
      const kc = new KubeConfig();
      // Use the in-cluster service account ONLY when actually running inside a pod
      // (KUBERNETES_SERVICE_HOST is injected there). `loadFromCluster()` does not throw off-cluster
      // — it builds a config pointing at /var/run/secrets/.../ca.crt that only fails lazily at
      // request time — so branching on the env var is what lets local dev use the kubeconfig.
      if (process.env.KUBERNETES_SERVICE_HOST) {
        kc.loadFromCluster();
      } else {
        kc.loadFromDefault();
      }
      this.batch = kc.makeApiClient(BatchV1Api);
    }
    return this.batch;
  }

  /** The Job template for the active mode: 'local' (plain SA + secret) or 'aks' (Workload Identity). */
  private template(): string {
    return this.config.k8sMode === 'local' ? JOB_TEMPLATE_LOCAL_YAML : JOB_TEMPLATE_YAML;
  }

  /** Renders the Job manifest for a job, substituting all template placeholders. */
  render(job: JobDocument, ctx: JobDispatchContext): V1Job {
    const values: Record<string, string> = {
      runId: job.runId,
      role: job.role,
      projectId: job.projectId.toString(),
      workItemId: job.workItemId ?? '',
      repo: job.repo ?? '',
      permissionMode: job.permissionMode,
      namespace: this.config.k8sNamespace,
      acr: this.config.acrLoginServer ?? 'acr.local',
      imageTag: this.config.workerImageTag ?? 'latest',
      backendEventsUrl: ctx.backendEventsUrl,
      perRunToken: ctx.perRunToken,
      maxTokens: String(this.config.maxRunTokens),
      claudeAuthMode: ctx.claudeAuthMode,
      // Local mode only: host gateway the pod maps host.docker.internal to (Docker Desktop default).
      hostGatewayIp: process.env.LOCAL_HOST_GATEWAY_IP ?? '192.168.65.254',
    };
    const rendered = this.template().replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      if (!(key in values)) {
        throw new Error(`Unknown job-template placeholder: {{${key}}}`);
      }
      return values[key];
    });
    const manifest = loadYaml<V1Job>(rendered);
    // Execution roles (developer, qa) get the ADO/MCP env overlay; the git-push env is present in
    // the context only for developer runs, so QA pods naturally receive ADO creds without any code
    // to push (ARCHITECTURE.md §4B, D-018).
    if (job.role === JobRole.Developer || job.role === JobRole.QA || job.role === JobRole.Verify) {
      AKSExecutionBackend.applyExecutionOverlay(manifest, ctx.executionOverlay);
    }
    return manifest;
  }

  /**
   * Adds the execution-role environment to a rendered Job (ARCHITECTURE.md §4A/§4B) without
   * duplicating the base template: ADO access for the in-pod ADO MCP (`ADO_PAT`/`ADO_MCP_CONFIG`/
   * `ADO_ORG`/`ADO_PROJECT`/`ADO_AREA_PATH`), the Claude API key (in `api` mode), the heartbeat
   * interval, and — for a Developer only — git push creds + identity + branch. The caller decides
   * which fields to populate per role (a QA overlay carries no git-push fields), so this method is
   * role-agnostic: entries with no value are skipped, and a name already present on the container
   * (e.g. `ANTHROPIC_API_KEY` wired via a Secret in the local template) is never overridden — so
   * secretRef-backed creds win over an injected literal.
   */
  static applyExecutionOverlay(manifest: V1Job, overlay: ExecutionOverlayContext = {}): void {
    // Wall-clock hard-stop for an execution run (defence-in-depth alongside MAX_TOKENS): a stuck pod
    // is killed by Kubernetes at the deadline. Kept even if the base template's value ever drifts.
    if (manifest.spec && !manifest.spec.activeDeadlineSeconds) {
      manifest.spec.activeDeadlineSeconds = 3600;
    }
    const container = manifest.spec?.template.spec?.containers?.[0];
    if (!container) {
      return;
    }
    container.env ??= [];
    const existing = new Set(container.env.map((e) => e.name));
    const candidates: V1EnvVar[] = [
      { name: 'GIT_CREDS', value: overlay.gitCreds },
      { name: 'ADO_PAT', value: overlay.adoPat },
      { name: 'ANTHROPIC_API_KEY', value: overlay.anthropicApiKey },
      { name: 'DEVELOPER_BRANCH', value: overlay.developerBranch },
      { name: 'GIT_AUTHOR_NAME', value: overlay.gitAuthorName },
      { name: 'GIT_AUTHOR_EMAIL', value: overlay.gitAuthorEmail },
      { name: 'ADO_MCP_CONFIG', value: overlay.adoMcpConfig },
      { name: 'ADO_ORG', value: overlay.adoOrg },
      { name: 'ADO_PROJECT', value: overlay.adoProject },
      { name: 'ADO_AREA_PATH', value: overlay.adoAreaPath },
      { name: 'TEST_RESULTS_API', value: overlay.testResultsApi },
      // The application's own credentials, by the names the planning agent declared.
      ...Object.entries(overlay.appSecrets ?? {}).map(([name, value]) => ({ name, value })),
      // How to start this product. Absent for every role but `verify`.
      ...Object.entries(overlay.verification ?? {}).map(([name, value]) => ({ name, value })),
      {
        name: 'RUN_HEARTBEAT_MS',
        value: overlay.runHeartbeatMs !== undefined ? String(overlay.runHeartbeatMs) : undefined,
      },
    ];
    for (const entry of candidates) {
      if (entry.value && !existing.has(entry.name)) {
        container.env.push(entry);
        existing.add(entry.name);
      }
    }
  }

  /**
   * Creates the K8s Job for a queued run. The pod then marks the run Running and streams events.
   *
   * A run keeps its id when it is re-dispatched, and the Job is named after that id — so the
   * leftover Job from the previous pod still holds the name. Kubernetes answers 409, the dispatch
   * fails, and the run goes back to Queued to be tried again, against the same leftover, forever.
   * That is a run stuck with nothing running behind it and no way out, which is the exact failure
   * lease-reclaim exists to end. Clearing the old Job first is what makes retry-not-resume work.
   */
  async startRun(job: JobDocument, ctx: JobDispatchContext): Promise<void> {
    const manifest = this.render(job, ctx);
    await this.clearPreviousJob(job.runId);
    await this.getBatch().createNamespacedJob(this.config.k8sNamespace, manifest);
    this.logger.log(`Created K8s Job aijob-${job.runId} (role=${job.role})`);
  }

  /**
   * Removes the Job left by an earlier pod for this run, and waits until it is really gone.
   *
   * Deletion is not immediate, so creating straight afterwards can still collide. Having nothing to
   * delete is the normal case on a first dispatch and is not an error.
   */
  private async clearPreviousJob(runId: string): Promise<void> {
    try {
      await this.getBatch().readNamespacedJob(`aijob-${runId}`, this.config.k8sNamespace);
    } catch {
      return; // nothing there — the ordinary first dispatch
    }
    this.logger.warn(`Job aijob-${runId} already exists; removing it before re-dispatching.`);
    await this.cancel(runId);
    for (let attempt = 0; attempt < JOB_DELETE_POLLS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, JOB_DELETE_POLL_MS));
      try {
        await this.getBatch().readNamespacedJob(`aijob-${runId}`, this.config.k8sNamespace);
      } catch {
        return; // gone
      }
    }
    throw new Error(
      `Job aijob-${runId} was still present ${(JOB_DELETE_POLLS * JOB_DELETE_POLL_MS) / 1000}s ` +
        'after being deleted; not re-dispatching over it.',
    );
  }

  /** Cancels a run by deleting its Job (Background propagation → pod terminates). */
  async cancel(runId: string): Promise<void> {
    await this.getBatch().deleteNamespacedJob(
      `aijob-${runId}`,
      this.config.k8sNamespace,
      undefined,
      undefined,
      undefined,
      undefined,
      'Background',
    );
    this.logger.log(`Deleted K8s Job aijob-${runId}`);
  }
}

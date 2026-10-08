/**
 * Local Job template (`K8S_MODE=local`) — for running real pods on a local Kubernetes
 * (kind/minikube/Docker Desktop) without Azure. Identical to the AKS template except for the three
 * Azure-specific assumptions that do not hold locally:
 *   1. no `azure.workload.identity/use` label (no Workload Identity webhook locally);
 *   2. `imagePullPolicy: IfNotPresent` (image is built + loaded into the node, not pulled from ACR);
 *   3. Claude credentials injected from a Kubernetes Secret (`ai-secrets`) instead of Key Vault — a
 *      fresh pod has no Claude login. Either a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, from
 *      `claude setup-token`, with `CLAUDE_AUTH_MODE=subscription`) or an `ANTHROPIC_API_KEY` (with
 *      `CLAUDE_AUTH_MODE=api`). Both env vars are optional so whichever key exists is used.
 * Everything else (non-root uid 1000, cap-drop, seccomp, emptyDir workspace, limits, bypass mode)
 * is unchanged, so isolation and permission behaviour match AKS. Kept in sync with
 * `k8s/local/job-template.local.yaml` (the reference manifest).
 */
export const JOB_TEMPLATE_LOCAL_YAML = `apiVersion: batch/v1
kind: Job
metadata:
  name: aijob-{{runId}}
  namespace: {{namespace}}
  labels:
    app: ai-worker
    runId: "{{runId}}"
    role: "{{role}}"
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 3600
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app: ai-worker
    spec:
      restartPolicy: Never
      serviceAccountName: ai-job-sa
      # Pods don't inherit the node's host.docker.internal entry, so map it explicitly to the host
      # gateway (Docker Desktop default 192.168.65.254; override with LOCAL_HOST_GATEWAY_IP).
      hostAliases:
        - ip: "{{hostGatewayIp}}"
          hostnames:
            - host.docker.internal
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: {{acr}}/ai-worker:{{imageTag}}
          imagePullPolicy: IfNotPresent
          args:
            - "--run-id={{runId}}"
            - "--role={{role}}"
            - "--project={{projectId}}"
            - "--work-item={{workItemId}}"
            - "--repo={{repo}}"
            - "--permission-mode={{permissionMode}}"
          env:
            - name: BACKEND_EVENTS_URL
              value: "{{backendEventsUrl}}"
            - name: RUN_TOKEN
              value: "{{perRunToken}}"
            - name: MAX_TOKENS
              value: "{{maxTokens}}"
            - name: CLAUDE_AUTH_MODE
              value: "{{claudeAuthMode}}"
            - name: CLAUDE_CODE_OAUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ai-secrets
                  key: claude-oauth-token
                  optional: true
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ai-secrets
                  key: anthropic-api-key
                  optional: true
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          emptyDir: {}
`;

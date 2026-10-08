/**
 * Versioned copy of the Kubernetes Job template (kept in sync with `k8s/job-template.yaml`, which
 * remains the deployment reference). Embedded in the app so the AKSExecutionBackend can render it
 * without a runtime file dependency. One Job = one pod = one AI job (ARCHITECTURE.md §4, §9).
 * Placeholders `{{...}}` are substituted per job before parsing.
 */
export const JOB_TEMPLATE_YAML = `apiVersion: batch/v1
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
        azure.workload.identity/use: "true"
    spec:
      restartPolicy: Never
      serviceAccountName: ai-job-sa
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: {{acr}}/ai-worker:{{imageTag}}
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

import { JobsService } from '../jobs/jobs.service';
import { TaskTransitionService } from '../development/task-transition.service';
import { DevQueueService } from '../development/dev-queue.service';
import { QaQueueService } from '../qa/qa-queue.service';
import { PlanningService } from '../planning/planning.service';
import { RunsGateway } from './runs.gateway';
import { RunsService } from './runs.service';
import { RunEventDto, RunEventType, RunResultStatus } from './dto/run-event.dto';

/**
 * Ingest → state-update → relay for the Runner API. Verifies the live-streaming contract (every
 * event is relayed to the UI) and that a terminal `result` event persists the Run Result including
 * developer commit SHAs (previously dropped).
 */
describe('RunsService', () => {
  let jobs: {
    claim: jest.Mock;
    markRunning: jest.Mock;
    heartbeat: jest.Mock;
    complete: jest.Mock;
    fail: jest.Mock;
    block: jest.Mock;
    getByRunId: jest.Mock;
  };
  let gateway: { relay: jest.Mock };
  let transitions: { completeTask: jest.Mock };
  let queue: { onRunFinished: jest.Mock };
  let qaQueue: { onRunFinished: jest.Mock };
  let planning: { noteRunFinished: jest.Mock };
  let service: RunsService;

  beforeEach(() => {
    jobs = {
      claim: jest.fn().mockResolvedValue(null),
      markRunning: jest.fn().mockResolvedValue(true),
      heartbeat: jest.fn().mockResolvedValue(true),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
      block: jest.fn().mockResolvedValue(undefined),
      getByRunId: jest
        .fn()
        .mockResolvedValue({ role: 'developer', workItemId: '19561', projectId: 'proj-1' }),
    };
    gateway = { relay: jest.fn() };
    transitions = { completeTask: jest.fn().mockResolvedValue(undefined) };
    queue = { onRunFinished: jest.fn().mockResolvedValue(undefined) };
    qaQueue = { onRunFinished: jest.fn().mockResolvedValue(undefined) };
    // A finished run tells planning, so a draft waiting on it is not left waiting for ever.
    planning = { noteRunFinished: jest.fn().mockResolvedValue(undefined) };
    service = new RunsService(
      jobs as unknown as JobsService,
      gateway as unknown as RunsGateway,
      transitions as unknown as TaskTransitionService,
      queue as unknown as DevQueueService,
      qaQueue as unknown as QaQueueService,
      planning as unknown as PlanningService,
    );
  });

  /**
   * The queue advances from here and nowhere else: a run reaching a terminal state is the only
   * moment a slot frees up. If this stopped firing, a batch would stall after its first Task.
   */
  describe('development queue hand-off', () => {
    it('advances the queue when a run completes', async () => {
      await service.ingest('run-1', {
        type: RunEventType.Result,
        status: RunResultStatus.Completed,
      });
      expect(queue.onRunFinished).toHaveBeenCalledWith('run-1', 'completed');
    });

    it('tells the queue a run failed, so it halts rather than continuing', async () => {
      await service.ingest('run-1', { type: RunEventType.Result, status: RunResultStatus.Failed });
      expect(queue.onRunFinished).toHaveBeenCalledWith('run-1', 'failed');
    });

    /** Blocked is not terminal — the run may still resume, so the queue must not move on. */
    it('leaves the queue alone when a run only reports blocked', async () => {
      await service.ingest('run-1', { type: RunEventType.Result, status: RunResultStatus.Blocked });
      expect(queue.onRunFinished).not.toHaveBeenCalled();
    });
  });

  describe('orchestrator-owned Task completion', () => {
    const completed: RunEventDto = { type: RunEventType.Result, status: RunResultStatus.Completed };

    it('moves the Task to Done only after a successful Developer run', async () => {
      await service.ingest('run-1', completed);
      expect(transitions.completeTask).toHaveBeenCalledWith('proj-1', '19561', 'run-1');
    });

    it('does not complete a Task for a non-Developer run', async () => {
      jobs.getByRunId.mockResolvedValue({ role: 'qa', workItemId: '19561', projectId: 'proj-1' });
      await service.ingest('run-1', completed);
      expect(transitions.completeTask).not.toHaveBeenCalled();
    });

    it('does not complete a Task when the run failed', async () => {
      await service.ingest('run-1', { type: RunEventType.Result, status: RunResultStatus.Failed });
      expect(transitions.completeTask).not.toHaveBeenCalled();
    });

    it('never lets a completion failure break run ingest', async () => {
      transitions.completeTask.mockRejectedValue(new Error('ADO down'));
      await expect(service.ingest('run-1', completed)).resolves.toBeUndefined();
      expect(gateway.relay).toHaveBeenCalled();
    });
  });

  it('relays every event to the UI (live streaming)', async () => {
    const event: RunEventDto = { type: RunEventType.Log, message: 'building' };
    await service.ingest('run-1', event);
    expect(gateway.relay).toHaveBeenCalledWith('run-1', event);
  });

  it('claims + marks running on the running event, and refreshes the lease on heartbeat', async () => {
    await service.ingest('run-1', { type: RunEventType.Running });
    expect(jobs.claim).toHaveBeenCalledWith('run-1', 'run-1');
    expect(jobs.markRunning).toHaveBeenCalledWith('run-1', 'run-1');

    await service.ingest('run-1', { type: RunEventType.Heartbeat });
    expect(jobs.heartbeat).toHaveBeenCalledWith('run-1', 'run-1');
  });

  it('persists the full Run Result contract (commits, adoChanges, filesChanged, workspacePath) on Completed', async () => {
    await service.ingest('run-1', {
      type: RunEventType.Result,
      status: RunResultStatus.Completed,
      durationMs: 1234,
      tokens: 5000,
      cost: 0.42,
      filesChanged: 3,
      commits: ['abc123', 'def456'],
      adoChanges: ['mcp__azure-devops__wit_update_work_item'],
      artifacts: [],
      workspacePath: '/workspace/repo',
    });
    expect(jobs.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        tokens: 5000,
        cost: 0.42,
        filesChanged: 3,
        commits: ['abc123', 'def456'],
        adoChanges: ['mcp__azure-devops__wit_update_work_item'],
        workspacePath: '/workspace/repo',
      }),
    );
  });

  /**
   * What the run itself says about the code that produced it.
   *
   * The incident: the worker image was rebuilt but never loaded into the cluster's containerd, so
   * every pod kept running old code and reported success. A fix that is not in the cluster and a
   * fix that does not work look identical from the outside; three investigations went the wrong
   * way because of it. `output` is what the agent actually wrote, `workerBuild` is which image
   * wrote it — both must survive the pod.
   */
  it('keeps the agent output and the worker build stamp with the run', async () => {
    await service.ingest('run-1', {
      type: RunEventType.Result,
      status: RunResultStatus.Completed,
      output: '[{"id":"e1-f1-s1","acceptanceCriteria":"- It works"}]',
      workerBuild: '2026-09-27T07:10:00Z',
    });
    expect(jobs.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        output: '[{"id":"e1-f1-s1","acceptanceCriteria":"- It works"}]',
        workerBuild: '2026-09-27T07:10:00Z',
      }),
    );
  });

  /** A run that reported neither must still store cleanly — absent is null, not undefined. */
  it('stores nulls when the run reported no output and no build stamp', async () => {
    await service.ingest('run-1', {
      type: RunEventType.Result,
      status: RunResultStatus.Completed,
    });
    expect(jobs.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ output: null, workerBuild: null }),
    );
  });

  /**
   * The run worth reading is the one that failed.
   *
   * `fail()` transitioned the job without its result, so a failed job carried `result: null` —
   * no output, no worker build stamp, nothing. The agent's own account of what went wrong died
   * with the pod, on precisely the runs anyone would investigate.
   */
  it('keeps the result of a run that failed', async () => {
    await service.ingest('run-1', {
      type: RunEventType.Result,
      status: RunResultStatus.Failed,
      output: 'error TS2304: Cannot find name ...',
      workerBuild: '2026-09-27T07:12:55Z',
      durationMs: 900,
    });
    expect(jobs.fail).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        output: 'error TS2304: Cannot find name ...',
        workerBuild: '2026-09-27T07:12:55Z',
      }),
    );
  });

  /**
   * Both queues hear about every finished run, and each ignores the ones that are not its own.
   *
   * The Development and QA queues share this single hook — it is the only moment a concurrency slot
   * frees up. Wiring the second one in is the risky edit: if a Developer run stopped reaching the
   * Development queue, a batch would stall after its first Task with nothing to say why.
   */
  it('tells both the development and the QA queue that a run finished', async () => {
    await service.ingest('run-1', {
      type: RunEventType.Result,
      status: RunResultStatus.Completed,
    });
    expect(queue.onRunFinished).toHaveBeenCalledWith('run-1', 'completed');
    expect(qaQueue.onRunFinished).toHaveBeenCalledWith('run-1', 'completed');

    await service.ingest('run-2', { type: RunEventType.Result, status: RunResultStatus.Failed });
    expect(queue.onRunFinished).toHaveBeenCalledWith('run-2', 'failed');
    expect(qaQueue.onRunFinished).toHaveBeenCalledWith('run-2', 'failed');
  });

  /** A Blocked run frees no slot and belongs to no outcome, so neither queue is advanced. */
  it('leaves both queues alone when a run only reports blocked', async () => {
    await service.ingest('run-1', { type: RunEventType.Result, status: RunResultStatus.Blocked });
    expect(queue.onRunFinished).not.toHaveBeenCalled();
    expect(qaQueue.onRunFinished).not.toHaveBeenCalled();
  });

  it('blocks on a Blocked result and fails on a Failed result', async () => {
    await service.ingest('run-1', { type: RunEventType.Result, status: RunResultStatus.Blocked });
    expect(jobs.block).toHaveBeenCalled();
    await service.ingest('run-2', { type: RunEventType.Result, status: RunResultStatus.Failed });
    expect(jobs.fail).toHaveBeenCalledWith('run-2', expect.any(Object));
  });
});

/** A single JSON Patch operation in the ADO `application/json-patch+json` document. */
export interface JsonPatchOperation {
  op: 'add' | 'replace' | 'remove' | 'test';
  path: string;
  value?: unknown;
}

/** Minimal shape of an ADO work item returned by the REST API. */
export interface AdoWorkItem {
  id: number;
  url: string;
  fields: Record<string, unknown>;
}

/** The target coordinates for a create (org/project/area/iteration), resolved from the draft. */
export interface AdoPushContext {
  /** The orchestrator project whose Azure DevOps credentials this push speaks with. */
  owner: string;
  orgUrl: string;
  project: string;
  areaPath: string;
  /** Default iteration path when a backlog item carries no explicit sprint. */
  defaultIterationPath: string;

  /**
   * Relative sprint name → the project's real sprint, for an enhancement.
   *
   * A Scrum Master numbers from one because it is planning a body of work, not reading a calendar.
   * For an initial build that is right. For an enhancement its "Sprint 1" is a sprint that closed
   * weeks ago, and work created there is in Azure DevOps, absent from the board, and picked up by
   * nothing. Empty for an initial plan, which means the names are written through unchanged.
   */
  sprintMapping?: ReadonlyMap<string, string>;
  /** Developer to assign Tasks to (email/unique name). */
  developerAssignee?: string | null;

  /**
   * The state a pushed Story is created in, resolved from the project's own process.
   *
   * Null when the process has no "ready" state to move to, in which case the Story keeps its
   * default — which is better than a name Azure DevOps will reject.
   */
  storyReadyState?: string | null;

  /**
   * The states Azure DevOps reported for the Story work item type, as a readable list.
   *
   * Carried only so a rejected create can quote them back. Azure DevOps reporting a state and then
   * refusing it is the kind of contradiction nobody believes without seeing both halves.
   */
  storyStateNames?: string | null;
}

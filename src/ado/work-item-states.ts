/** One state of a work item type, as Azure DevOps reports it. */
export interface WorkItemState {
  name: string;
  /** `Proposed` | `InProgress` | `Resolved` | `Completed` | `Removed`. */
  category: string;
}

/**
 * The state a freshly pushed Story should be created in.
 *
 * A push only happens after a person approved the draft, and that *is* the approval. Leaving the
 * Story in its first state would demand a second, identical approval in Azure DevOps before any of
 * its Tasks could run, so the push writes the "ready to be worked" state instead.
 *
 * Which name that is depends entirely on the process: Scrum calls it `Approved`, and an inherited
 * process can call it anything. Hardcoding `Approved` produced
 * "The field 'State' contains the value 'Approved' that is not in the list of supported values"
 * against a project whose backlog item simply did not have that state — a failure with no useful
 * next step, because nothing in the message says what the states actually are.
 *
 * So the name is chosen from what the project reports:
 *   1. a state literally called `Approved`, which keeps every existing Scrum project identical;
 *   2. otherwise the *last* `Proposed` state, which is the one after "new" — the conventional
 *      shape of "triaged and ready" in processes that have it;
 *   3. otherwise nothing, and the Story is left in its default state rather than a guess.
 *
 * Returning null is a real answer: better a Story that needs approving in Azure DevOps than a push
 * that fails outright on every item.
 */
export function pickReadyState(states: WorkItemState[]): string | null {
  const usable = (states ?? []).filter((s) => s?.name?.trim());
  const named = usable.find((s) => s.name.trim().toLowerCase() === 'approved');
  if (named) return named.name;

  const proposed = usable.filter((s) => s.category === 'Proposed');
  // One proposed state means there is no "ready" step to move to — only "new".
  if (proposed.length < 2) return null;
  return proposed[proposed.length - 1].name;
}

/** Names the states a type has, for a message someone can act on. */
export function describeStates(states: WorkItemState[]): string {
  const names = (states ?? []).map((s) => s?.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'none reported';
}

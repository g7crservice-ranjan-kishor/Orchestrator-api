import { Model, Types } from 'mongoose';
import { DraftDocument } from './schemas/draft.schema';
import { activeDraft } from './draft-selection';

/**
 * Reading a project's plans, now that it may have more than one.
 *
 * Nine places in the orchestrator fetched "the project's draft" with `findOne({ projectId })`,
 * which was correct while a unique index guaranteed there was only one. Each of them now has to say
 * which plan it means, and almost all mean the same thing: the one being worked on.
 *
 * Two functions rather than a service, because the nine live in seven different modules — each
 * already injects the model, and giving them a shared service instead would mean seven new module
 * imports for one query.
 *
 * **For a project with one plan these return exactly what `findOne` returned**, which is what makes
 * every call site a no-op until a second plan exists.
 */

/** Every plan the project has, oldest first. */
export async function allDrafts(
  model: Model<DraftDocument>,
  projectId: string,
): Promise<DraftDocument[]> {
  return model
    .find({ projectId: new Types.ObjectId(projectId) })
    .sort({ seq: 1 })
    .exec();
}

/**
 * The plan a request about "this project" means — the unfinished one, else the most recent.
 *
 * Null when the project has no plan at all, matching what `findOne` gave, so callers keep their
 * existing "no planning draft for this project" handling.
 */
export async function findActiveDraft(
  model: Model<DraftDocument>,
  projectId: string,
): Promise<DraftDocument | null> {
  return activeDraft(await allDrafts(model, projectId));
}

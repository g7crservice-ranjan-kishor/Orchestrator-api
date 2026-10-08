import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BlobService } from '../common/storage/blob.service';
import { KB_ARCHITECTURE, kbDocName, kbDocOf, kbKey, kbPrefix } from './knowledge-base.paths';

/** One knowledge base document, as the API and the agents see it. */
export interface KnowledgeDoc {
  name: string;
  text: string;
}

/**
 * A project's knowledge base: what this product is, and the rules anything built for it follows.
 *
 * **Why it exists.** Four role templates already instruct agents to "follow the Knowledge Base",
 * and the prompt composer already reads one from a cloned repository — but nothing ever wrote one,
 * so every run on every generated product has read that instruction and found nothing. Each run
 * rediscovered the product's conventions from the code: Developer run #898 spent its entire
 * 1,000,000-token budget doing so and was killed before it could commit the work it had finished.
 * Two Tasks a day apart chose a white header and white header text, because there was nowhere for
 * the first to tell the second.
 *
 * **Why Blob rather than the repository.** It is needed before a repository exists — a planning run
 * has no checkout at all — and a product with two repositories needs one knowledge base, not two
 * copies that drift. Conventions that describe *code which already exists* still belong in that
 * code's repository, where they change in the same commit as the thing they describe.
 *
 * **Why no stored path.** The location is derived from the project id. See `knowledge-base.paths`.
 *
 * Every read degrades to empty rather than failing: an unconfigured or unreachable store must
 * leave the agents exactly as well off as they were before this existed, which is to say grounded
 * by their templates alone.
 */
@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);

  constructor(private readonly blob: BlobService) {}

  get isConfigured(): boolean {
    return this.blob.isConfigured;
  }

  /** The document names a project holds, alphabetically. Empty when it has none. */
  async list(projectId: string): Promise<string[]> {
    if (!this.blob.isConfigured) return [];
    try {
      const keys = await this.blob.list(`${kbPrefix(projectId)}/`);
      return keys
        .map((key) => kbDocOf(projectId, key))
        .filter((name): name is string => name !== null)
        .sort();
    } catch (err) {
      this.logger.warn(`Could not list the knowledge base for ${projectId}: ${asMessage(err)}`);
      return [];
    }
  }

  /** One document, or null when the project does not have it. */
  async read(projectId: string, name: string): Promise<string | null> {
    if (!this.blob.isConfigured) return null;
    try {
      return await this.blob.getText(kbKey(projectId, name));
    } catch (err) {
      this.logger.warn(`Could not read ${name} for ${projectId}: ${asMessage(err)}`);
      return null;
    }
  }

  /**
   * Everything the project holds, for grounding a prompt.
   *
   * Best-effort as a whole: a knowledge base that cannot be read must not stop a run, because the
   * run was perfectly possible before any of this existed.
   */
  async readAll(projectId: string): Promise<KnowledgeDoc[]> {
    const names = await this.list(projectId);
    const docs: KnowledgeDoc[] = [];
    for (const name of names) {
      const text = await this.read(projectId, name);
      if (text?.trim()) docs.push({ name, text });
    }
    return docs;
  }

  /** Writes (or replaces) a document. Throws when storage is not configured — a write must not vanish. */
  async write(projectId: string, name: string, text: string): Promise<KnowledgeDoc> {
    const doc = kbDocName(name);
    await this.blob.putText(kbKey(projectId, doc), text);
    this.logger.log(`Knowledge base ${doc} written for ${projectId}.`);
    return { name: doc, text };
  }

  async remove(projectId: string, name: string): Promise<void> {
    const doc = kbDocName(name);
    if ((await this.read(projectId, doc)) === null) {
      throw new NotFoundException(`This project has no knowledge base document called ${doc}.`);
    }
    await this.blob.removeText(kbKey(projectId, doc));
  }

  /**
   * Writes the approved plan's architecture into the knowledge base, once.
   *
   * The plan already says what the product is, how it is built and what constrains it — it is the
   * best description of the project that exists at the moment of the push, and until now it was
   * read once by the Scrum Master and never seen again. Seeding from it means the very first
   * Developer run starts informed rather than exploring.
   *
   * **It never overwrites.** A knowledge base that has been edited — by a person or by an agent
   * recording what it learned — holds more than the plan did, and a later push must not undo that.
   * Best-effort: a push is about Azure DevOps, and must not fail because a document could not be
   * written beside it.
   */
  async seedFromPlan(projectId: string, planMarkdown: string | null): Promise<boolean> {
    if (!this.blob.isConfigured || !planMarkdown?.trim()) return false;
    try {
      if (await this.read(projectId, KB_ARCHITECTURE)) return false; // already has one
      await this.write(projectId, KB_ARCHITECTURE, seedDocument(planMarkdown));
      return true;
    } catch (err) {
      this.logger.warn(`Could not seed the knowledge base for ${projectId}: ${asMessage(err)}`);
      return false;
    }
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The plan, with a line saying where it came from so a reader knows what they are looking at. */
export function seedDocument(planMarkdown: string): string {
  return [
    '<!-- Seeded from the approved plan when this product was first pushed to Azure DevOps.',
    '     Edit it freely: it is never overwritten by a later push. -->',
    '',
    planMarkdown.trim(),
    '',
  ].join('\n');
}

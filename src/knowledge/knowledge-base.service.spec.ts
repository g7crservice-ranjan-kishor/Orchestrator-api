import { NotFoundException } from '@nestjs/common';
import { KnowledgeBaseService, seedDocument } from './knowledge-base.service';
import { BlobService } from '../common/storage/blob.service';

/**
 * A project's knowledge base.
 *
 * Four role templates already told agents to "follow the Knowledge Base" and nothing ever wrote
 * one, so every run on every generated product read that instruction and found nothing. The
 * failures that follows from: Developer run #898 spent its entire 1,000,000-token budget
 * rediscovering conventions from the code and was killed before it could commit the work it had
 * finished; two Tasks a day apart chose a white header and white header text, because there was
 * nowhere for the first to tell the second.
 *
 * So the two things that matter here are that it **degrades to empty** rather than breaking a run,
 * and that seeding **never overwrites** what someone has since written.
 */

const PROJECT = '6abe2b5bd8ca853c7a61bd31';
const PREFIX = `${PROJECT}/knowledge-base`;

describe('KnowledgeBaseService', () => {
  let blob: {
    isConfigured: boolean;
    list: jest.Mock;
    getText: jest.Mock;
    putText: jest.Mock;
    removeText: jest.Mock;
  };
  let service: KnowledgeBaseService;

  beforeEach(() => {
    blob = {
      isConfigured: true,
      list: jest.fn().mockResolvedValue([]),
      getText: jest.fn().mockResolvedValue(null),
      putText: jest.fn().mockResolvedValue(undefined),
      removeText: jest.fn().mockResolvedValue(undefined),
    };
    service = new KnowledgeBaseService(blob as unknown as BlobService);
  });

  describe('listing what a project holds', () => {
    it('names the documents, alphabetically', async () => {
      blob.list.mockResolvedValue([`${PREFIX}/conventions.md`, `${PREFIX}/architecture.md`]);
      expect(await service.list(PROJECT)).toEqual(['architecture.md', 'conventions.md']);
    });

    /** Isolation is the point of keying by project id. */
    it('ignores anything that is not this project’s', async () => {
      blob.list.mockResolvedValue([`${PREFIX}/architecture.md`, 'other/knowledge-base/leak.md']);
      expect(await service.list(PROJECT)).toEqual(['architecture.md']);
    });

    it('ignores anything nested deeper than a document', async () => {
      blob.list.mockResolvedValue([`${PREFIX}/sub/deep.md`]);
      expect(await service.list(PROJECT)).toEqual([]);
    });

    it('has nothing to say when storage is not configured', async () => {
      blob.isConfigured = false;
      expect(await service.list(PROJECT)).toEqual([]);
      expect(blob.list).not.toHaveBeenCalled();
    });

    /** A run was perfectly possible before any of this existed; it must stay that way. */
    it('reports empty rather than throwing when storage is unreachable', async () => {
      blob.list.mockRejectedValue(new Error('storage down'));
      expect(await service.list(PROJECT)).toEqual([]);
    });
  });

  describe('reading', () => {
    it('returns a document’s text', async () => {
      blob.getText.mockResolvedValue('# Architecture');
      expect(await service.read(PROJECT, 'architecture')).toBe('# Architecture');
      expect(blob.getText).toHaveBeenCalledWith(`${PREFIX}/architecture.md`);
    });

    it('returns nothing for a document the project does not have', async () => {
      expect(await service.read(PROJECT, 'missing')).toBeNull();
    });

    it('gathers every document for grounding a prompt', async () => {
      blob.list.mockResolvedValue([`${PREFIX}/architecture.md`, `${PREFIX}/conventions.md`]);
      blob.getText.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith('architecture.md') ? '# Arch' : '# Conventions'),
      );
      expect(await service.readAll(PROJECT)).toEqual([
        { name: 'architecture.md', text: '# Arch' },
        { name: 'conventions.md', text: '# Conventions' },
      ]);
    });

    /** An empty file is noise in a prompt, not knowledge. */
    it('leaves an empty document out', async () => {
      blob.list.mockResolvedValue([`${PREFIX}/architecture.md`, `${PREFIX}/blank.md`]);
      blob.getText.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith('blank.md') ? '   ' : '# Arch'),
      );
      expect(await service.readAll(PROJECT)).toEqual([{ name: 'architecture.md', text: '# Arch' }]);
    });
  });

  describe('writing', () => {
    it('writes under the derived key, with a tidied name', async () => {
      await service.write(PROJECT, 'Domain Glossary', '# Terms');
      expect(blob.putText).toHaveBeenCalledWith(`${PREFIX}/domain-glossary.md`, '# Terms');
    });

    /** A write that vanishes is worse than one that fails. */
    it('fails loudly when storage is not configured', async () => {
      blob.putText.mockRejectedValue(new Error('not configured'));
      await expect(service.write(PROJECT, 'architecture', '# A')).rejects.toThrow();
    });

    it('refuses to remove a document that is not there', async () => {
      await expect(service.remove(PROJECT, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
      expect(blob.removeText).not.toHaveBeenCalled();
    });
  });

  describe('seeding from the approved plan', () => {
    it('writes the plan the first time a product is pushed', async () => {
      const seeded = await service.seedFromPlan(PROJECT, '# Plan\n\nAn employee directory.');
      expect(seeded).toBe(true);
      expect(blob.putText).toHaveBeenCalledWith(
        `${PREFIX}/architecture.md`,
        expect.stringContaining('An employee directory.') as unknown as string,
      );
    });

    /**
     * The rule that makes the knowledge base worth editing: a later push must never undo what a
     * person — or an agent recording what it learned — has written since.
     */
    it('never overwrites a knowledge base that already exists', async () => {
      blob.getText.mockResolvedValue('# Architecture\n\nEdited by hand since.');
      expect(await service.seedFromPlan(PROJECT, '# Plan')).toBe(false);
      expect(blob.putText).not.toHaveBeenCalled();
    });

    it('seeds nothing from a plan that is not there', async () => {
      expect(await service.seedFromPlan(PROJECT, null)).toBe(false);
      expect(await service.seedFromPlan(PROJECT, '   ')).toBe(false);
    });

    it('does nothing at all when storage is not configured', async () => {
      blob.isConfigured = false;
      expect(await service.seedFromPlan(PROJECT, '# Plan')).toBe(false);
    });

    /** A push is about Azure DevOps; a document written beside it must not be able to fail it. */
    it('gives up quietly when the write fails', async () => {
      blob.putText.mockRejectedValue(new Error('storage down'));
      await expect(service.seedFromPlan(PROJECT, '# Plan')).resolves.toBe(false);
    });
  });

  describe('seedDocument', () => {
    it('says where it came from and that editing is safe', () => {
      const doc = seedDocument('# Plan');
      expect(doc).toMatch(/Seeded from the approved plan/);
      expect(doc).toMatch(/never overwritten/);
      expect(doc).toContain('# Plan');
    });
  });
});

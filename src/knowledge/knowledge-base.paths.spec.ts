import { kbDocName, kbDocOf, kbKey, kbPrefix } from './knowledge-base.paths';

/**
 * The knowledge base's location is **computed**, never stored.
 *
 * A `knowledgeBasePath` field on the project record would be a second source of truth for something
 * that already has one. Every failure this project has had of that shape started the same way: two
 * places that must agree, and nothing noticing when they stop. A path that can be derived is not
 * configuration.
 */

const PROJECT = '6abe2b5bd8ca853c7a61bd31';

describe('kbPrefix', () => {
  it('puts a project’s knowledge base under its own id', () => {
    expect(kbPrefix(PROJECT)).toBe(`${PROJECT}/knowledge-base`);
  });

  /** Isolation is the point: two projects can never read each other's. */
  it('keeps two projects apart', () => {
    expect(kbPrefix('p1')).not.toBe(kbPrefix('p2'));
  });

  it('refuses to guess without a project', () => {
    expect(() => kbPrefix('')).toThrow(/project id/i);
    expect(() => kbPrefix('   ')).toThrow(/project id/i);
  });
});

describe('kbDocName', () => {
  it('leaves a well-formed name alone', () => {
    expect(kbDocName('architecture.md')).toBe('architecture.md');
    expect(kbDocName('domain-glossary.md')).toBe('domain-glossary.md');
  });

  it('settles on one spelling of the same name', () => {
    expect(kbDocName('Architecture')).toBe('architecture.md');
    expect(kbDocName('  Domain Glossary  ')).toBe('domain-glossary.md');
    expect(kbDocName('API_Contract.md')).toBe('api-contract.md');
  });

  /** A name carrying a slash would quietly file a document where nothing looks for it. */
  it('refuses to let a name become a folder', () => {
    expect(kbDocName('notes/secret.md')).toBe('notes-secret.md');
    expect(kbDocName('../escape.md')).toBe('escape.md');
  });

  it('refuses a name with nothing in it', () => {
    expect(() => kbDocName('')).toThrow(/usable/i);
    expect(() => kbDocName('***')).toThrow(/usable/i);
  });
});

describe('kbKey', () => {
  it('puts a document inside its project’s folder', () => {
    expect(kbKey(PROJECT, 'architecture')).toBe(`${PROJECT}/knowledge-base/architecture.md`);
  });
});

describe('kbDocOf', () => {
  it('reads the document name back out', () => {
    expect(kbDocOf(PROJECT, kbKey(PROJECT, 'conventions'))).toBe('conventions.md');
  });

  /** A key belonging to another project is not this project's document. */
  it('does not claim another project’s document', () => {
    expect(kbDocOf(PROJECT, kbKey('other-project', 'conventions'))).toBeNull();
  });

  it('ignores anything nested deeper', () => {
    expect(kbDocOf(PROJECT, `${PROJECT}/knowledge-base/sub/deep.md`)).toBeNull();
  });

  it('ignores the folder itself', () => {
    expect(kbDocOf(PROJECT, `${PROJECT}/knowledge-base/`)).toBeNull();
  });
});

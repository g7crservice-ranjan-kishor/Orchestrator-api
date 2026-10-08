import { DATABASE_CHOICES, DEFAULT_DATABASE, databaseConstraint } from './database-choice';

/**
 * The database a project is built against.
 *
 * The reason this exists: a plan that specifies PostgreSQL while the team has an Azure SQL server
 * ready produces a credential nobody can satisfy, and the mismatch only shows up when the
 * connection string fails to parse. The choice is therefore an input to planning.
 */
describe('databaseConstraint', () => {
  it('defaults to SQL Server, including for a project saved before the field existed', () => {
    expect(DEFAULT_DATABASE).toBe('sqlserver');
    expect(databaseConstraint(undefined)?.id).toBe('sqlserver');
    expect(databaseConstraint(null)?.id).toBe('sqlserver');
  });

  it('imposes nothing when the planner is left to decide', () => {
    expect(databaseConstraint('unset')).toBeNull();
  });

  it('names the database and how its connection string is shaped', () => {
    const sql = databaseConstraint('sqlserver')!;
    expect(sql.label).toBe('SQL Server / Azure SQL');
    expect(sql.guidance).toContain('sqlserver://');
    expect(sql.guidance).toContain('DATABASE_URL');
  });

  /** A document store needs a different credential name, not just a different URL. */
  it('asks MongoDB projects for MONGODB_URI rather than DATABASE_URL', () => {
    const mongo = databaseConstraint('mongodb')!;
    expect(mongo.guidance).toContain('MONGODB_URI');
    expect(mongo.guidance).not.toContain('DATABASE_URL');
  });

  it('gives every offered choice a label, and guidance unless it is the open option', () => {
    for (const [id, choice] of Object.entries(DATABASE_CHOICES)) {
      expect(choice.label).not.toBe('');
      if (id !== 'unset') {
        expect(choice.guidance.length).toBeGreaterThan(40);
      }
    }
  });
});

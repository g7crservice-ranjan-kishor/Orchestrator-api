import {
  claimedOperation,
  criteriaIgnoreTitle,
  contradictedBy,
  describeOperation,
  namesHttpMethod,
  operationsIn,
} from './story-operation';

/**
 * Acceptance criteria that are about something other than the item they are attached to.
 *
 * A real backlog had its CRUD criteria shifted by one: the Story titled `PUT /employees/:id
 * (update)` carried the criteria for creating, and the `DELETE` Story beneath it carried the
 * update criteria. Every criterion was well-formed, so the repository check, the sprint check, the
 * dependency check and the parent check all passed.
 *
 * It matters because **QA verifies against the acceptance criteria**. A delete Story checked
 * against update criteria passes while delete is broken — and delete had no criteria of its own at
 * all, so nobody would ever have tested it.
 */

/** The exact text from that backlog. */
const UPDATE_STORY = 'PUT /employees/:id (update) with backend validation';
const CREATE_CRITERIA = [
  '- A request with valid Name, Email, Department and Designation creates the employee, persists',
  '  it to the database, and returns 201 with the created employee',
  '- The created employee appears in the employee list immediately without a page refresh',
].join('\n');

const DELETE_STORY = 'DELETE /employees/:id with not-found and failure handling';
const UPDATE_CRITERIA = [
  '- A request with valid Name, Email, Department and Designation updates the employee and',
  '  returns 200 with the updated employee',
  "- The updated employee's data appears in the employee list immediately without a page refresh",
].join('\n');

describe('the operation a title claims', () => {
  it('reads it from the HTTP method', () => {
    expect(claimedOperation('POST /employees (create)')).toBe('create');
    expect(claimedOperation(DELETE_STORY)).toBe('delete');
  });

  it('reads it from a plain verb', () => {
    expect(claimedOperation('Delete Employee confirmation modal')).toBe('delete');
  });

  /** Nothing to check against. */
  it('claims none when the title names no operation', () => {
    expect(claimedOperation('Employee table with loading and empty states')).toBeNull();
  });

  /** Two claims are not a contradiction waiting to happen. */
  it('claims none when the title names several', () => {
    expect(claimedOperation('Create and update an employee')).toBeNull();
  });
});

describe('contradiction between title and criteria', () => {
  /** The two real failures. */
  it('catches an update Story carrying create criteria', () => {
    expect(contradictedBy(UPDATE_STORY, CREATE_CRITERIA)).toBe('create');
  });

  it('catches a delete Story carrying update criteria', () => {
    expect(contradictedBy(DELETE_STORY, UPDATE_CRITERIA)).toBe('update');
  });

  it('accepts criteria that match the title', () => {
    const criteria = '- DELETE /employees/:id removes the employee and returns 204';
    expect(contradictedBy(DELETE_STORY, criteria)).toBeNull();
  });

  /**
   * A Story doing its job mentions more than one thing: deleting is confirmed by the row being
   * gone from the list. Flagging that would make the gate noise.
   */
  it('accepts criteria that mention the claimed operation alongside others', () => {
    const criteria = [
      '- Confirming the dialog deletes the employee',
      '- The employee no longer appears in the list returned by GET /employees',
      '- A second delete of the same id returns 404',
    ].join('\n');
    expect(contradictedBy(DELETE_STORY, criteria)).toBeNull();
  });

  /** Reading is mentioned almost everywhere, so it is never enough on its own to call it wrong. */
  it('does not call a Story wrong only because its criteria mention a list', () => {
    const criteria = '- The employee appears in the list afterwards';
    expect(contradictedBy('POST /employees (create)', criteria)).toBeNull();
  });

  it('says nothing when the title claims nothing', () => {
    expect(contradictedBy('Employee table', CREATE_CRITERIA)).toBeNull();
  });

  /** Missing criteria are a different problem, reported by a different rule. */
  it('says nothing when there are no criteria at all', () => {
    expect(contradictedBy(DELETE_STORY, '')).toBeNull();
  });
});

describe('unambiguous titles', () => {
  it('recognises an HTTP method', () => {
    expect(namesHttpMethod('PUT /employees/:id (update)')).toBe(true);
  });

  /**
   * The false positive this guard exists for: a Task beginning "Add …" whose criteria mention a
   * field being "removed" claims nothing about creating or deleting anything.
   */
  it('does not treat an ordinary Task title as a claim', () => {
    expect(namesHttpMethod('Add response-schema validation tests for all employee endpoints')).toBe(
      false,
    );
  });
});

describe('reading operations out of text', () => {
  it('finds every operation mentioned', () => {
    expect(operationsIn('creates it, then updates it, then deletes it').sort()).toEqual([
      'create',
      'delete',
      'update',
    ]);
  });

  it('puts each operation into a sentence', () => {
    expect(describeOperation('create')).toBe('creating');
    expect(describeOperation('delete')).toBe('deleting');
  });
});

/**
 * Criteria that never mention what their own Story is about.
 *
 * The CRUD criteria in one backlog were shifted by one *twice*. The second time landed them on
 * "Logout endpoint and session invalidation" and "Auth middleware protecting all employee
 * endpoints" — Stories whose titles name no operation at all, so comparing claimed against
 * described could not see them. What is visible is that neither set of criteria mentions logging
 * out, sessions, auth or middleware.
 */
describe('criteria that ignore their title', () => {
  /** The real titles, so "employee" and "endpoint" are as common here as they were there. */
  const TITLES = [
    'Login endpoint',
    'Logout endpoint and session invalidation',
    'Auth middleware protecting all employee endpoints',
    'GET /employees with name/email search',
    'POST /employees (create) with backend validation',
    'PUT /employees/:id (update) with backend validation',
    'DELETE /employees/:id with not-found and failure handling',
    'Employee table with loading, empty and error states',
    'Search employees by name or email',
    'Add Employee modal form',
  ];

  const CREATE_CRITERIA =
    '- A request with a valid name, email, department and designation creates the employee and ' +
    'returns 201 with the created record';

  it('catches a logout Story carrying employee-create criteria', () => {
    expect(
      criteriaIgnoreTitle('Logout endpoint and session invalidation', CREATE_CRITERIA, TITLES),
    ).toBe(true);
  });

  it('catches an auth-middleware Story carrying employee-update criteria', () => {
    const criteria = '- A request with a valid name and email updates the employee and returns 200';
    expect(
      criteriaIgnoreTitle('Auth middleware protecting all employee endpoints', criteria, TITLES),
    ).toBe(true);
  });

  it('accepts criteria that do mention the Story', () => {
    const criteria = [
      '- A request with a token after logout is rejected',
      '- The session is invalidated server-side',
    ].join(String.fromCharCode(10));
    expect(criteriaIgnoreTitle('Logout endpoint and session invalidation', criteria, TITLES)).toBe(
      false,
    );
  });

  /**
   * A login Story describes credentials and tokens without using the word "login". Flagging it
   * would be the noise that gets a gate ignored, so criteria that change nothing are left alone.
   */
  it('leaves a Story whose criteria describe no change at all', () => {
    const criteria = [
      '- Correct email and password returns 200 and a session token',
      '- A wrong password returns 401',
    ].join(String.fromCharCode(10));
    expect(criteriaIgnoreTitle('Login endpoint', criteria, TITLES)).toBe(false);
  });

  /** Words in many titles say nothing about any one item. */
  it('does not count a word common to the whole backlog as a match', () => {
    const criteria = '- The employee is created and returned with 201';
    expect(criteriaIgnoreTitle('Logout endpoint and session invalidation', criteria, TITLES)).toBe(
      true,
    );
  });

  it('says nothing when there are no criteria', () => {
    expect(criteriaIgnoreTitle('Logout endpoint', '', TITLES)).toBe(false);
  });

  /** A title with nothing distinctive left cannot be judged either way. */
  it('says nothing when the title is all common words', () => {
    expect(criteriaIgnoreTitle('Employee endpoints', CREATE_CRITERIA, TITLES)).toBe(false);
  });
});

import { DEFAULT_UI_STYLE, UI_STYLE_CHOICES, uiStyleConstraint } from './ui-style-choice';

/**
 * How the generated interface is built.
 *
 * Why this exists: a project shipped working authentication, task CRUD and routing behind a
 * thirteen-line stylesheet, because nothing upstream of a Task ever described a look. Requirements
 * state behaviour and acceptance criteria state outcomes, so the styling approach has to be an
 * input like the database, not something an agent is left to infer.
 */
describe('uiStyleConstraint', () => {
  it('defaults to Ant Design, including for a project saved before the field existed', () => {
    expect(DEFAULT_UI_STYLE).toBe('antd');
    expect(uiStyleConstraint(undefined)?.id).toBe('antd');
    expect(uiStyleConstraint(null)?.id).toBe('antd');
  });

  it('imposes nothing when the developer is left to decide', () => {
    expect(uiStyleConstraint('unset')).toBeNull();
  });

  it('tells the agent to compose from the library rather than hand-roll CSS', () => {
    const antd = uiStyleConstraint('antd')!;
    expect(antd.label).toBe('Ant Design');
    expect(antd.guidance).toMatch(/ConfigProvider/);
    expect(antd.guidance).toMatch(/Empty|Spin/); // the states a bare implementation forgets
  });

  /** Whatever the approach, colours must come from one place or two Tasks will disagree. */
  it('asks every styled choice to centralise its theme', () => {
    for (const id of ['antd', 'tailwind', 'mui', 'css'] as const) {
      expect(uiStyleConstraint(id)!.guidance).toMatch(/theme|token|config/i);
    }
  });

  it('gives every offered choice a label, and guidance unless it is the open option', () => {
    for (const [id, choice] of Object.entries(UI_STYLE_CHOICES)) {
      expect(choice.label).not.toBe('');
      if (id !== 'unset') expect(choice.guidance.length).toBeGreaterThan(80);
    }
  });
});

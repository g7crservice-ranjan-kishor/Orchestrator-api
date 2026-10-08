/**
 * How a project's generated user interface is built and styled.
 *
 * Without this, nothing anywhere asks for a look. The requirement describes behaviour, the plan
 * describes features, the acceptance criteria describe outcomes — and an agent that is told none of
 * it ships a working application with a thirteen-line stylesheet, which is exactly what happened.
 * Stating the approach up front also stops two Tasks styling the same app two different ways.
 */
export const UI_STYLE_CHOICES = {
  antd: {
    label: 'Ant Design',
    guidance:
      'Build the UI with **Ant Design** (`antd`). Compose screens from its components — `Layout`, ' +
      '`Menu`, `Card`, `Form`, `Input`, `Button`, `Table`, `Modal`, `Typography`, `Empty`, `Spin`, ' +
      '`message` — rather than raw `<div>`/`<input>` with hand-written CSS. Wrap the app in a ' +
      '`ConfigProvider` whose theme tokens live in one file, so colours and radii are changed in ' +
      'one place. Use `Form` with `rules` for validation so errors appear inline against the ' +
      'field, `message`/`notification` for the outcome of an action, `Spin` while data loads and ' +
      '`Empty` when there is none. Use the `Row`/`Col` grid for layout. Write bespoke CSS only for ' +
      'what Ant Design does not already provide.',
  },
  tailwind: {
    label: 'Tailwind CSS',
    guidance:
      'Build the UI with **Tailwind CSS**. Style with utility classes in the markup; do not add a ' +
      'parallel hand-written stylesheet. Keep colours, spacing and typography on the Tailwind ' +
      'theme in `tailwind.config`, and compose repeated patterns into components rather than ' +
      'copying long class lists.',
  },
  mui: {
    label: 'Material UI',
    guidance:
      'Build the UI with **Material UI** (`@mui/material`). Compose screens from its components ' +
      'and lay them out with its `Grid`/`Stack`. Put palette, typography and spacing in a single ' +
      '`createTheme` call applied through `ThemeProvider`, rather than styling components ad hoc.',
  },
  css: {
    label: 'Plain CSS with design tokens',
    guidance:
      'Build the UI with plain CSS, no component library. Declare colours, spacing, radii and ' +
      'typography as custom properties on `:root` in one tokens file, and reference those tokens ' +
      'everywhere — never a raw hex value in a component. Use semantic, predictable class names so ' +
      'separate Tasks styling separate screens produce one coherent application.',
  },
  /** No constraint — the agent chooses, which is how every project behaved before this existed. */
  unset: { label: 'Let the developer decide', guidance: '' },
} as const;

export type UiStyleChoice = keyof typeof UI_STYLE_CHOICES;

export const UI_STYLE_IDS = Object.keys(UI_STYLE_CHOICES) as UiStyleChoice[];

/** What a project gets when nothing was chosen, including projects created before this existed. */
export const DEFAULT_UI_STYLE: UiStyleChoice = 'antd';

/** The constraint handed to an agent, or null when the project imposes none. */
export function uiStyleConstraint(
  id: UiStyleChoice | undefined | null,
): { id: UiStyleChoice; label: string; guidance: string } | null {
  const choice = id ?? DEFAULT_UI_STYLE;
  const entry = UI_STYLE_CHOICES[choice];
  if (!entry || entry.guidance === '') {
    return null;
  }
  return { id: choice, label: entry.label, guidance: entry.guidance };
}

/**
 * The human name of each choice, keyed by its id.
 *
 * The technical-details table compares what a requirement *says* ("MongoDB") with what the project
 * has *chosen* (`mongodb`), and those have to be the same words or the same decision reads as two.
 */
export const UI_STYLE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(UI_STYLE_CHOICES).map(([id, entry]) => [id, entry.label]),
);

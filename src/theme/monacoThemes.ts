import type { ThemeId } from './themes'

/**
 * Monaco editor palettes for every application theme. Kept as plain data so
 * the editor setup can register them without pulling Monaco types into the
 * theme registry. Colours intentionally mirror the CSS custom properties so
 * the editor and the surrounding UI stay in sync.
 */
export interface MonacoThemeDefinition {
  base: 'vs' | 'vs-dark'
  inherit: boolean
  rules: Array<{ token: string; foreground: string; fontStyle?: string }>
  colors: Record<string, string>
}

interface PaletteInput {
  base: 'vs' | 'vs-dark'
  background: string
  foreground: string
  lineNumber: string
  activeLine: string
  selection: string
  lineHighlight: string
  cursor: string
  indent: string
  widget: string
  border: string
  comment: string
  keyword: string
  string: string
  number: string
  operator: string
  type: string
}

function makeTheme(p: PaletteInput): MonacoThemeDefinition {
  return {
    base: p.base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: p.comment, fontStyle: 'italic' },
      { token: 'keyword', foreground: p.keyword },
      { token: 'string', foreground: p.string },
      { token: 'number', foreground: p.number },
      { token: 'operator', foreground: p.operator },
      { token: 'type', foreground: p.type },
    ],
    colors: {
      'editor.background': p.background,
      'editor.foreground': p.foreground,
      'editorLineNumber.foreground': p.lineNumber,
      'editorLineNumber.activeForeground': p.activeLine,
      'editor.selectionBackground': p.selection,
      'editor.lineHighlightBackground': p.lineHighlight,
      'editorCursor.foreground': p.cursor,
      'editorIndentGuide.background': p.indent,
      'editorGutter.background': p.background,
      'scrollbarSlider.background': p.border,
      'scrollbarSlider.hoverBackground': p.border,
      'editorWidget.background': p.widget,
      'editorWidget.border': p.border,
      'editorSuggestWidget.background': p.widget,
      'editorSuggestWidget.border': p.border,
      'editorSuggestWidget.selectedBackground': p.selection,
      'editorHoverWidget.background': p.widget,
      'editorHoverWidget.border': p.border,
      'editorBracketMatch.background': p.selection,
      'editorBracketMatch.border': p.cursor,
    },
  }
}

export const MONACO_THEMES: Record<ThemeId, MonacoThemeDefinition> = {
  light: makeTheme({
    base: 'vs',
    background: '#ffffff',
    foreground: '#101828',
    lineNumber: '#98a2b3',
    activeLine: '#475467',
    selection: '#dbe7ff',
    lineHighlight: '#f4f7fc',
    cursor: '#2563eb',
    indent: '#e7ecf4',
    widget: '#ffffff',
    border: '#d8e0ec',
    comment: '#7c8db5',
    keyword: '#1d4ed8',
    string: '#047857',
    number: '#b45309',
    operator: '#475467',
    type: '#7c3aed',
  }),
  dark: makeTheme({
    base: 'vs-dark',
    background: '#0d1322',
    foreground: '#e6ebf5',
    lineNumber: '#3d4c6b',
    activeLine: '#8fa8d8',
    selection: '#24406e',
    lineHighlight: '#111a30',
    cursor: '#6ea8ff',
    indent: '#1b2743',
    widget: '#131c33',
    border: '#2c3a5c',
    comment: '#5b6b8f',
    keyword: '#6ea8ff',
    string: '#9be2b3',
    number: '#f0b269',
    operator: '#9fb6df',
    type: '#c792ea',
  }),
  midnight: makeTheme({
    base: 'vs-dark',
    background: '#0a1020',
    foreground: '#e8eefb',
    lineNumber: '#33415c',
    activeLine: '#6b8ab8',
    selection: '#164e63',
    lineHighlight: '#0f1830',
    cursor: '#5eb0ff',
    indent: '#1b2740',
    widget: '#101b30',
    border: '#26385a',
    comment: '#5f7396',
    keyword: '#7dd3fc',
    string: '#86efac',
    number: '#fbbf24',
    operator: '#a5b4cf',
    type: '#c4b5fd',
  }),
  dracula: makeTheme({
    base: 'vs-dark',
    background: '#282a36',
    foreground: '#f8f8f2',
    lineNumber: '#6272a4',
    activeLine: '#bd93f9',
    selection: '#44475a',
    lineHighlight: '#2f313d',
    cursor: '#d8b4fe',
    indent: '#44475a',
    widget: '#343746',
    border: '#565a75',
    comment: '#9aa3c7',
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    operator: '#ff79c6',
    type: '#8be9fd',
  }),
  nord: makeTheme({
    base: 'vs-dark',
    background: '#2e3440',
    foreground: '#eceff4',
    lineNumber: '#6b7a94',
    activeLine: '#a3d3e0',
    selection: '#434c5e',
    lineHighlight: '#333b49',
    cursor: '#a3d3e0',
    indent: '#434c5e',
    widget: '#343b49',
    border: '#5b667d',
    comment: '#8b98b3',
    keyword: '#a3d3e0',
    string: '#c8e6b0',
    number: '#d8b4d0',
    operator: '#a8d8d6',
    type: '#a8d8d6',
  }),
  'solarized-dark': makeTheme({
    base: 'vs-dark',
    background: '#002b36',
    foreground: '#eee8d5',
    lineNumber: '#4f9aa8',
    activeLine: '#7cc4f0',
    selection: '#0a404d',
    lineHighlight: '#043039',
    cursor: '#7cc4f0',
    indent: '#073642',
    widget: '#073642',
    border: '#155e6e',
    comment: '#6f8f8f',
    keyword: '#b8d45a',
    string: '#6fd0c7',
    number: '#f0a0a8',
    operator: '#b8d45a',
    type: '#f0c860',
  }),
  glassy: makeTheme({
    base: 'vs-dark',
    background: '#0c1220',
    foreground: '#eef4ff',
    lineNumber: '#7f93b3',
    activeLine: '#a5f3fc',
    // Monaco's standalone theme service expects hex colours; rgba() values
    // are rejected and fall back to opaque red for the active-line overlay.
    // 8-digit hex keeps the intended translucent glass effect.
    selection: '#67e8f933',
    lineHighlight: '#ffffff0d',
    cursor: '#67e8f9',
    indent: '#ffffff24',
    widget: '#131d31',
    border: '#2a3a55',
    comment: '#93a7c4',
    keyword: '#7dd3fc',
    string: '#86efac',
    number: '#fcd34d',
    operator: '#c4b5fd',
    type: '#f0abfc',
  }),
  bloody: makeTheme({
    base: 'vs-dark',
    background: '#0a0505',
    foreground: '#f7e9e9',
    lineNumber: '#6b4a4a',
    activeLine: '#f87171',
    selection: '#4c1010',
    lineHighlight: '#140a0a',
    cursor: '#ef4444',
    indent: '#2a1010',
    widget: '#180b0b',
    border: '#3f1a1a',
    comment: '#9a7a7a',
    keyword: '#f87171',
    string: '#fca5a5',
    number: '#fbbf24',
    operator: '#fca5a5',
    type: '#fb7185',
  }),
  cyberpunk: makeTheme({
    base: 'vs-dark',
    background: '#05010f',
    foreground: '#f3ecff',
    lineNumber: '#5a4a7a',
    activeLine: '#67e8f9',
    selection: '#164e63',
    lineHighlight: '#0b0618',
    cursor: '#22d3ee',
    indent: '#1a0b2e',
    widget: '#0e0720',
    border: '#2c1454',
    comment: '#8b7aa8',
    keyword: '#ff2d95',
    string: '#22d3ee',
    number: '#fbbf24',
    operator: '#a855f7',
    type: '#67e8f9',
  }),
}
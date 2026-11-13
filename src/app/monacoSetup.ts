import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import type { TableSchema } from '../types/database'

/**
 * Monaco configuration, executed once per page load.
 *
 * - Bundles Monaco locally (no CDN dependency).
 * - Registers the editor web worker required by Vite.
 * - Defines the app's dark/light editor themes.
 * - Provides SQL autocomplete backed by the live database schema.
 */

declare global {
  // eslint-disable-next-line no-var
  var MonacoEnvironment: monaco.Environment | undefined
}

;(self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}

loader.config({ monaco })

/** Schema accessor injected by the editor component; refreshes per query. */
let schemaAccessor: () => TableSchema[] = () => []
export function setSchemaAccessor(accessor: () => TableSchema[]): void {
  schemaAccessor = accessor
}

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT',
  'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE', 'JOIN', 'INNER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN', 'ON', 'AND', 'OR', 'NOT', 'NULL',
  'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'AS', 'ASC', 'DESC',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL', 'INTERSECT',
  'EXCEPT', 'WITH', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'PRAGMA',
]

const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'ROUND', 'ABS',
  'UPPER', 'LOWER', 'LENGTH', 'SUBSTR', 'TRIM', 'REPLACE', 'COALESCE',
  'IFNULL', 'NULLIF', 'CAST', 'DATE', 'TYPEOF', 'IIF', 'ROW_NUMBER',
]

const SQL_SNIPPETS: monaco.languages.CompletionItem[] = [
  {
    label: 'JOIN template',
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText:
      'SELECT t1.column1, t2.column2\nFROM table1 t1\nINNER JOIN table2 t2\n  ON t1.key = t2.key;',
    documentation: 'Two-table join template',
    sortText: '0_join_template',
  } as monaco.languages.CompletionItem,
  {
    label: 'Aggregate template',
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText:
      'SELECT group_column, COUNT(*) AS n\nFROM table_name\nGROUP BY group_column\nHAVING COUNT(*) > 1;',
    documentation: 'GROUP BY with HAVING template',
    sortText: '0_aggregate_template',
  } as monaco.languages.CompletionItem,
]

let initialized = false

export function setupMonaco(): void {
  if (initialized) return
  initialized = true

  monaco.editor.defineTheme('sqlviz-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5b6b8f', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6ea8ff' },
      { token: 'string', foreground: '9be2b3' },
      { token: 'number', foreground: 'f0b269' },
      { token: 'operator', foreground: '9fb6df' },
      { token: 'type', foreground: 'c792ea' },
    ],
    colors: {
      'editor.background': '#0d1322',
      'editor.foreground': '#e6ebf5',
      'editorLineNumber.foreground': '#3d4c6b',
      'editorLineNumber.activeForeground': '#8fa8d8',
      'editor.selectionBackground': '#24406e',
      'editor.lineHighlightBackground': '#111a30',
      'editorCursor.foreground': '#6ea8ff',
      'editorIndentGuide.background': '#1b2743',
      'editorGutter.background': '#0d1322',
      'scrollbarSlider.background': '#22304f80',
      'scrollbarSlider.hoverBackground': '#2c3a5c80',
      'editorWidget.background': '#131c33',
      'editorWidget.border': '#2c3a5c',
      'editorSuggestWidget.background': '#131c33',
      'editorSuggestWidget.border': '#2c3a5c',
      'editorSuggestWidget.selectedBackground': '#22304f',
      'editorHoverWidget.background': '#131c33',
      'editorHoverWidget.border': '#2c3a5c',
      'editorBracketMatch.background': '#22304f',
      'editorBracketMatch.border': '#3d5a91',
    },
  })

  monaco.editor.defineTheme('sqlviz-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7c8db5', fontStyle: 'italic' },
      { token: 'keyword', foreground: '1d4ed8' },
      { token: 'string', foreground: '047857' },
      { token: 'number', foreground: 'b45309' },
      { token: 'operator', foreground: '475467' },
      { token: 'type', foreground: '7c3aed' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#101828',
      'editorLineNumber.foreground': '#98a2b3',
      'editorLineNumber.activeForeground': '#475467',
      'editor.selectionBackground': '#dbe7ff',
      'editor.lineHighlightBackground': '#f4f7fc',
      'editorCursor.foreground': '#2563eb',
      'editorIndentGuide.background': '#e7ecf4',
      'editorGutter.background': '#ffffff',
    },
  })

  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      const tables = schemaAccessor()

      // "alias." — suggest columns of the referenced table only.
      const lineBefore = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      const dotMatch = /([A-Za-z_][\w]*)\.$/.exec(lineBefore)
      if (dotMatch) {
        const aliasLower = (dotMatch[1] ?? '').toLowerCase()
        // Exact table name match narrows suggestions; aliases (Stage 1)
        // fall back to all columns with the owning table in the detail.
        const target = tables.find(
          (table) => table.name.toLowerCase() === aliasLower,
        )
        const columns =
          target?.columns ?? tables.flatMap((table) => table.columns)
        return {
          suggestions: columns.map((column) => ({
            label: column.name,
            kind: monaco.languages.CompletionItemKind.Field,
            detail: target ? `${target.name}.${column.type}` : column.type,
            insertText: column.name,
            range,
          })),
        }
      }

      const suggestions: monaco.languages.CompletionItem[] = [
        ...tables.map((table) => ({
          label: table.name,
          kind: monaco.languages.CompletionItemKind.Struct,
          detail: `${table.columns.length} columns`,
          insertText: table.name,
          sortText: '1_' + table.name,
          range,
        })),
        ...tables.flatMap((table) =>
          table.columns.map((column) => ({
            label: column.name,
            kind: monaco.languages.CompletionItemKind.Field,
            detail: `${table.name} · ${column.type}`,
            insertText: column.name,
            sortText: '2_' + column.name,
            range,
          })),
        ),
        ...SQL_KEYWORDS.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          sortText: '3_' + keyword,
          range,
        })),
        ...SQL_FUNCTIONS.map((fn) => ({
          label: fn,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn + '()',
          sortText: '4_' + fn,
          range,
        })),
        ...SQL_SNIPPETS.map((snippet) => ({ ...snippet, range })),
      ]

      return { suggestions }
    },
  })
}

export { monaco }

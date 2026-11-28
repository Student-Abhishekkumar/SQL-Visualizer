import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import * as monaco from 'monaco-editor/editor/editor.api'

/*
 * Monaco's package root registers every bundled language and the
 * TypeScript/CSS/HTML/JSON language services. This app only edits SQL, so
 * load the core editor API plus the editor features a SQL scratchpad can
 * actually surface (selection, find, folding, suggest, hover, multi-cursor,
 * formatting and the a11y toggles), then register only the SQL grammar.
 *
 * Contributions that need a language service this editor does not have —
 * diff editor, code lens, color picker, document symbols, rename, semantic
 * tokens, parameter hints, inlay hints, sticky scroll and linked editing —
 * are deliberately absent: they could only render empty UI here. Keeping
 * them out is most of the saving on the editor chunk.
 */
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js'
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js'
import 'monaco-editor/editor/contrib/format/browser/formatActions.js'
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js'
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js'
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js'
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js'
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/links/browser/links.js'
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js'
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js'
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js'
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import 'monaco-editor/languages/definitions/sql/register.js'

import { loader } from '@monaco-editor/react'
import type { TableSchema } from '../types/database'
import { MONACO_THEMES } from '../theme/monacoThemes'

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

  for (const [id, definition] of Object.entries(MONACO_THEMES)) {
    monaco.editor.defineTheme(`sqlviz-${id}`, definition)
  }

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

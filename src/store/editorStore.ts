import { create } from 'zustand'
import { DEFAULT_QUERY } from '../components/editor/exampleQueries'

/**
 * SQL editor state — kept separate from database state so editor
 * content survives tab switches and executions untouched.
 */
interface EditorState {
  content: string
  setContent: (content: string) => void
  /** Load a query, replacing current content. */
  loadQuery: (sql: string) => void
  clear: () => void
}

export const useEditorStore = create<EditorState>()((set) => ({
  content: DEFAULT_QUERY,
  setContent: (content) => set({ content }),
  loadQuery: (sql) => set({ content: sql }),
  clear: () => set({ content: '' }),
}))

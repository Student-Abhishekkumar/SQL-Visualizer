import { create } from 'zustand'
import { DEFAULT_QUERY } from '../components/editor/exampleQueries'

/**
 * SQL editor state — kept separate from database state so editor
 * content survives tab switches and executions untouched.
 *
 * `stageHighlight` carries the playback-synced clause selection as a
 * character-offset range into `content` (from the clause mapper). The
 * Monaco editor renders it as a decoration; it is cleared whenever the
 * content changes so stale highlighting can never linger.
 */
interface EditorState {
  content: string
  /** Character-offset range into `content`, or null when nothing is highlighted. */
  stageHighlight: { start: number; end: number; stage: string } | null
  setContent: (content: string) => void
  /** Load a query, replacing current content. */
  loadQuery: (sql: string) => void
  /** Highlight the clause for the active playback stage. */
  setStageHighlight: (highlight: { start: number; end: number; stage: string } | null) => void
  clear: () => void
}

export const useEditorStore = create<EditorState>()((set) => ({
  content: DEFAULT_QUERY,
  stageHighlight: null,
  setContent: (content) => set({ content, stageHighlight: null }),
  loadQuery: (sql) => set({ content: sql, stageHighlight: null }),
  setStageHighlight: (highlight) => set({ stageHighlight: highlight }),
  clear: () => set({ content: '', stageHighlight: null }),
}))

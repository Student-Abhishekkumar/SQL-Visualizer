import { useEditorStore } from '../store/editorStore'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import { resetDatabase } from '../services/database/databaseInitializer'

/**
 * Development-only automation bridge (import.meta.env.DEV).
 * Lets test scripts and Stage 2 tooling drive the app without DOM
 * gymnastics. Tree-shaken out of production builds.
 */
export function installDevBridge(): void {
  ;(window as unknown as Record<string, unknown>).__sqlviz = {
    setEditor: (sql: string) => useEditorStore.getState().loadQuery(sql),
    getEditor: () => useEditorStore.getState().content,
    run: (sql?: string) => {
      const text = sql ?? useEditorStore.getState().content
      if (sql !== undefined) useEditorStore.getState().loadQuery(sql)
      return useDatabaseStore.getState().execute(text)
    },
    history: () => useHistoryStore.getState().history,
    clearHistory: () => useHistoryStore.getState().clearAllHistory(),
    resetDatabase: () => resetDatabase(),
  }
}

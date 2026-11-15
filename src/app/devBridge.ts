import { useEditorStore } from '../store/editorStore'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import { useUIStore } from '../store/uiStore'
import { useVisualizationStore } from '../store/visualizationStore'
import type { DatabaseTemplateId } from '../types/database'

/**
 * Development-only automation bridge (import.meta.env.DEV).
 * Lets test scripts and Stage 2 tooling drive the app without DOM
 * gymnastics. Tree-shaken out of production builds.
 */
export function installDevBridge(): void {
  ;(window as unknown as Record<string, unknown>).__sqlviz = {
    setEditor: (sql: string) => useEditorStore.getState().loadQuery(sql),
    getEditor: () => useEditorStore.getState().content,
    getEditorHighlight: () => useEditorStore.getState().stageHighlight,
    run: (sql?: string) => {
      const text = sql ?? useEditorStore.getState().content
      if (sql !== undefined) useEditorStore.getState().loadQuery(sql)
      return useDatabaseStore.getState().execute(text)
    },
    history: () => useHistoryStore.getState().history,
    clearHistory: () => useHistoryStore.getState().clearAllHistory(),
    resetDatabase: () => useDatabaseStore.getState().resetDatabase(),
    databases: () => useDatabaseStore.getState().databases,
    getActiveDatabaseId: () => useDatabaseStore.getState().activeDatabaseId,
    openDatabase: (id: string) => useDatabaseStore.getState().openDatabase(id),
    createDatabase: (input: {
      name: string
      description?: string
      template: DatabaseTemplateId
      setupSql?: string
    }) =>
      useDatabaseStore.getState().createDatabase({
        name: input.name,
        description: input.description,
        template: input.template === 'imported' ? 'blank' : input.template,
        setupSql: input.setupSql,
      }),
    renameDatabase: (id: string, name: string) =>
      useDatabaseStore.getState().renameDatabase(id, name),
    duplicateDatabase: (id: string, name?: string) =>
      useDatabaseStore.getState().duplicateDatabase(id, name),
    deleteDatabase: (id: string) => useDatabaseStore.getState().deleteDatabase(id),
    getSchema: () => useDatabaseStore.getState().schema,
    setView: (view: 'query' | 'canvas') => useUIStore.getState().setWorkspaceView(view),
    getView: () => useUIStore.getState().workspaceView,
    getPlayback: () => {
      const state = useVisualizationStore.getState()
      return {
        eventIndex: state.eventIndex,
        totalEvents: state.trace?.events.length ?? 0,
        type: state.viewState.event?.type ?? null,
        stage: state.viewState.event?.stage ?? null,
        activeStage: state.viewState.activeStage,
        playing: state.playing,
        finished: state.finished,
        databaseId: state.databaseId,
        completedStages: state.viewState.completedStages.map((snapshot) => snapshot.stage),
      }
    },
  }
}

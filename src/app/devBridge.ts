import { useEditorStore } from '../store/editorStore'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import { useUIStore } from '../store/uiStore'
import { useVisualizationStore } from '../store/visualizationStore'
import { getLiveDatabase } from '../services/database/databaseManager'
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
    /**
     * Read-only positional query against the live database. Browser QA uses
     * it to prove that an isolated preview left the real database untouched.
     */
    query: (sql: string) => {
      const db = getLiveDatabase()
      if (db === null) return null
      return db.queryAll(sql)
    },
    /**
     * Compact, serializable snapshot of the visualization state.
     * Browser QA uses it to assert that the Canvas belongs to the query it
     * just visualized, without depending on DOM heuristics.
     */
    getTrace: () => {
      const state = useVisualizationStore.getState()
      const trace = state.trace
      const stagesOf = (snapshots: Array<{ stage: string }>) => {
        const seen: string[] = []
        for (const snapshot of snapshots) {
          if (snapshot.stage !== 'FROM' && !seen.includes(snapshot.stage)) seen.push(snapshot.stage)
        }
        return seen
      }
      return {
        sessionId: state.sessionId,
        status: state.status,
        unavailableReasons: [...state.unavailableReasons],
        validation: state.validation,
        trace:
          trace === null
            ? null
            : {
                query: trace.query,
                statementType: trace.statementType,
                rootBlockId: trace.rootBlockId,
                stages: [...trace.stages],
                snapshots: trace.stageSnapshots.map((snapshot) => ({
                  stage: snapshot.stage,
                  blockId: snapshot.blockId,
                  rows: snapshot.rows.length,
                  columns: snapshot.columns.length,
                })),
                nested: (trace.nestedQueries ?? []).map((block) => ({
                  id: block.id,
                  label: block.label,
                  kind: block.kind,
                  depth: block.depth ?? 1,
                  stages: stagesOf(block.stageSnapshots),
                  finalColumns: [...block.finalColumns],
                  finalRows: block.finalRows.length,
                })),
                compound: (trace.compound?.operations ?? []).map((operation) => ({
                  id: operation.id,
                  operator: operation.operator,
                  rows: operation.snapshot.rows.length,
                })),
                branches: (trace.compound?.branches ?? []).map((branch) => branch.blockId),
                isDml: trace.dml !== undefined,
                isDdl: trace.ddl !== undefined,
                dml:
                  trace.dml === undefined
                    ? null
                    : {
                        operation: trace.dml.operation,
                        targetTable: trace.dml.targetTable,
                        affectedRowCount: trace.dml.affectedRowCount,
                        finalRowCount: trace.dml.finalRowCount,
                        matched: trace.dml.matchedRowIds.length,
                        changed: trace.dml.changedRowIds.length,
                        unchanged: trace.dml.unchangedRowIds.length,
                        inserted: trace.dml.insertedRowIds.length,
                        deleted: trace.dml.deletedRowIds.length,
                      },
                ddl:
                  trace.ddl === undefined
                    ? null
                    : {
                        objectType: trace.ddl.objectType,
                        objectName: trace.ddl.objectName,
                        noOp: trace.ddl.noOp,
                        rowDataChanged: trace.ddl.rowDataChanged,
                        beforeTable: trace.ddl.before?.table?.name ?? null,
                        afterTable: trace.ddl.after?.table?.name ?? null,
                        beforeIndex: trace.ddl.before?.index?.name ?? null,
                        afterIndex: trace.ddl.after?.index?.name ?? null,
                      },
                finalColumns: [...trace.finalColumns],
                finalRows: trace.finalRows.length,
                capability: {
                  supported: trace.capability.supported,
                  isReadOnly: trace.capability.isReadOnly,
                  warnings: [...trace.capability.warnings],
                },
              },
      }
    },
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

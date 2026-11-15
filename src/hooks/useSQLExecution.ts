import { useCallback } from 'react'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import type { QueryExecutionResult } from '../types/query'

/**
 * Bridge between the editor UI and the database store: executes the
 * current SQL and records the outcome in the persistent history.
 */
export function useSQLExecution() {
  const isExecuting = useDatabaseStore((state) => state.isExecuting)
  const lastResult = useDatabaseStore((state) => state.lastResult)

  const execute = useCallback(async (sql: string): Promise<QueryExecutionResult> => {
    const result = await useDatabaseStore.getState().execute(sql)
    useHistoryStore.getState().recordExecution(result, result.databaseId)
    return result
  }, [])

  return { execute, isExecuting, lastResult }
}

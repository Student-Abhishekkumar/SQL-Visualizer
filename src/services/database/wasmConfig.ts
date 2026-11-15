import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { SqlJsConfig } from './databaseManager'

/**
 * Browser-specific sql.js configuration: point the WASM loader at the
 * asset bundled by Vite so the app works fully offline.
 */
export const browserSqlJsConfig: SqlJsConfig = {
  locateFile: () => wasmUrl,
}

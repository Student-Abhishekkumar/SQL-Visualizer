/**
 * Reset bridge between the database store and the (lazily loaded)
 * visualization store.
 *
 * `databaseStore` is part of the initial bundle, while the visualization
 * engine is only needed once the user opens the Canvas. Importing the
 * visualization store here would drag the entire engine into the initial
 * download, so the store registers a reset handler when it loads and the
 * database store calls through this indirection. Before the engine has
 * loaded there is no trace to clear, so a missing handler is correct.
 */

type ResetHandler = () => void

let handler: ResetHandler | null = null

/** Called by the visualization store on module load. */
export function registerVisualizationReset(next: ResetHandler | null): void {
  handler = next
}

/** Clear any trace/results that belong to a database we just left. */
export function resetVisualizationForDatabaseSwitch(): void {
  handler?.()
}
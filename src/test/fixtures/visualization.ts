/**
 * Shared visualization-trace fixtures for tests.
 *
 * One canonical trace keeps the inspector UI tests and the data-resolution
 * unit tests from drifting apart. Test-only: not imported by app code.
 */

import type { StageSnapshot, VisualizationTrace } from '../../types/visualization'

const DEFAULT_COLUMNS = ['name', 'salary']

/** A deterministic stage snapshot with real-looking rows. */
export function stageSnapshot(
  stage: StageSnapshot['stage'],
  rowCount: number,
  removedCount = 0,
  groups: StageSnapshot['groups'] = [],
): StageSnapshot {
  return {
    stage,
    label: `${stage} step`,
    columns: DEFAULT_COLUMNS,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: `r${index + 1}`,
      values: [`person ${index + 1}`, 50000 + index],
    })),
    removedRows: Array.from({ length: removedCount }, (_, index) => ({
      id: `x${index + 1}`,
      values: [`removed ${index + 1}`, index],
    })),
    roles: {},
    groups,
    explanation: `${stage} explanation`,
    inputRowCount: rowCount + removedCount,
    outputRowCount: rowCount,
    truncated: false,
  }
}

/** FROM → WHERE → SELECT trace with a single source table. */
export function makeTrace(options: { whereRows?: number } = {}): VisualizationTrace {
  const whereRows = options.whereRows ?? 4
  return {
    query: 'SELECT name, salary FROM employees WHERE salary > 50000',
    statementType: 'SELECT',
    capability: {
      supported: true,
      supportedStages: ['FROM', 'WHERE', 'SELECT'],
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: false,
      hasJoin: false,
      estimatedComplexity: 'small',
    },
    stages: ['FROM', 'WHERE', 'SELECT'],
    events: [],
    stageSnapshots: [
      stageSnapshot('FROM', 8),
      stageSnapshot('WHERE', whereRows, 4),
      stageSnapshot('SELECT', whereRows),
    ],
    sourceTables: [
      {
        name: 'employees',
        alias: 'e',
        columns: DEFAULT_COLUMNS,
        rowCount: 8,
        previewRows: Array.from({ length: 6 }, (_, index) => ({
          id: `employees#${index + 1}`,
          values: [`person ${index + 1}`, 50000 + index],
        })),
        role: 'from',
        joinType: null,
        on: null,
      },
    ],
    totalSteps: 0,
    finalRows: [{ id: 'r1', values: ['person 1', 50000] }],
    finalColumns: DEFAULT_COLUMNS,
    hasDeterministicOrder: false,
    truncated: false,
  }
}

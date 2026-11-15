import type { DatabaseInfo } from '../../types/database'

/** Compact, locale-stable metadata formatting for the database UI. */
export function formatDatabaseDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  return value.toLocaleString()
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function tableSummary(info: DatabaseInfo): string {
  const tables = `${formatCount(info.tableCount)} table${info.tableCount === 1 ? '' : 's'}`
  return `${tables} · ${formatCount(info.rowCount)} rows`
}

import { logError } from '../utils/log.js'

export function settingsWriteLanded(migration: string, verdict: { error: Error | null }): boolean {
  if (verdict.error === null) return true
  logError(
    new Error(
      `startup migration ${migration}: the settings write was refused, so the source of truth is kept and the migration retries next boot — ${verdict.error.message}`,
    ),
  )
  return false
}

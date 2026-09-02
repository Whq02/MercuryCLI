// ============================================================================
//  The settings-write verdict every startup migration reads before its
//  destructive half (release-hardening audit rank 17).
//
//  Each relocating migration writes a settings file and then deletes the
//  key it relocated from the global config (or stamps its own completion
//  flag). updateSettingsForSource REFUSES a write when the target file is
//  not parseable JSON (a file mid-edit is never overwritten) or when the
//  atomic publish fails (a transient EPERM/EBUSY hold on Windows), and
//  reports that as a returned { error } — which every migration discarded.
//  The relocated value then lived in neither place, and because the runner
//  stamped the version regardless the set never ran again: the loss was
//  permanent (MCP approvals asked again, the dangerous-mode acceptance
//  dialog back, a model pin the notice claims was updated).
//
//  The law: a migration whose settings write did not land keeps its source
//  of truth in place, reports itself incomplete, and the runner withholds
//  the version stamp so the set retries on a later boot.
// ============================================================================
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

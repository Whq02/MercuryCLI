// ============================================================================
//  src/extensions/load/optionSchema.ts — the option schema for one
//  extension id, for the hook executor's spawn-time substitution. Read from
//  the active set when a session loaded one; otherwise from the record's
//  copy on disk (a headless caller running a hook before any load).
// ============================================================================
import { getActiveSet, hasActiveSet } from '../active.js'
import { readManifest, type ManifestNeeds } from '../manifest.js'
import { installedOrEmpty } from '../records.js'

export function optionSchemaFor(id: string): NonNullable<ManifestNeeds['options']> | undefined {
  if (hasActiveSet()) {
    const ext = getActiveSet().active.find(e => e.entry.id === id)
    if (ext) return ext.manifest.needs?.options
  }
  const record = installedOrEmpty()[id]
  if (!record) return undefined
  const manifest = readManifest(record.path)
  return manifest.status === 'ok' ? manifest.manifest.needs?.options : undefined
}

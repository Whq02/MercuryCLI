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

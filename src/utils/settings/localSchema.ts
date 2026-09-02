import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome } from '../envUtils.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'

/**
 * The LOCAL settings schema — Mercury's own, generated from the live
 * validator source (SettingsSchema → schemaOutput), never a foreign URL.
 * The runtime refreshes it into the config home so a written settings
 * file's `$schema` resolves to real validation of REAL Mercury settings:
 * correct offline, versioned with the installed build. The committed
 * review snapshot lives at scripts/settings/settings-schema.json
 * (regenerate: bun scripts/settings/gen-settings-schema.ts); the
 * settings suite pins the two against drift.
 */

/** Where the config home carries the schema for editors to resolve. */
export function settingsSchemaLocalPath(): string {
  return join(getMercuryHome(), 'schema', 'settings.schema.json')
}

/**
 * Write/refresh the local schema (byte-compare first — the steady-state
 * boot is one read). Returns the path, or null when the home is
 * unwritable: the schema is an editor affordance and never blocks a
 * settings write.
 */
export function ensureLocalSettingsSchema(): string | null {
  const path = settingsSchemaLocalPath()
  const generated = `${generateSettingsJSONSchema()}\n`
  try {
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = null
    }
    if (existing !== generated) {
      durableAtomicPublishSync(path, generated)
    }
    return path
  } catch {
    return null
  }
}

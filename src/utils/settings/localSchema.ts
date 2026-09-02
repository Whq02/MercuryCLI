import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome } from '../envUtils.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'


export function settingsSchemaLocalPath(): string {
  return join(getMercuryHome(), 'schema', 'settings.schema.json')
}

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

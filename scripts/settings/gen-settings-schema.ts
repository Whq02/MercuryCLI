#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-gen' }

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outFlag = process.argv.indexOf('--out')
const outPath =
  outFlag !== -1 && process.argv[outFlag + 1]
    ? (process.argv[outFlag + 1] as string)
    : join(import.meta.dir, 'settings-schema.json')

const { generateSettingsJSONSchema } = await import('../../src/utils/settings/schemaOutput.js')
writeFileSync(outPath, `${generateSettingsJSONSchema()}\n`)
console.log(`settings schema regenerated → ${outPath}`)

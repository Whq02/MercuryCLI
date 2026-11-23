#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-gen' }

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ROW = {
  assets: 'scripts/settings/settings-schema.json',
  generator: 'bun scripts/settings/gen-settings-schema.ts',
  check: 'bun scripts/settings/prove-settings-schema.ts',
  sources: 'src/platform/settings/** src/integrations/video-shapes/types.ts src/integrations/event-hook-schemas/hooks.ts src/models/effort/effortLadder.ts src/platform/primitives/lazySchema.ts src/permissions/rules/permissionMode.ts src/platform/logs/slowOperations.ts',
}
if (registerOnlyRequested(ROW)) process.exit(0)

const outFlag = process.argv.indexOf('--out')
const outPath =
  outFlag !== -1 && process.argv[outFlag + 1]
    ? (process.argv[outFlag + 1] as string)
    : join(import.meta.dir, 'settings-schema.json')

const { generateSettingsJSONSchema } = await import('../../src/platform/settings/schemaOutput.js')
writeFileSync(outPath, `${generateSettingsJSONSchema()}\n`)
if (outFlag === -1) registerGeneratedAsset(ROW)
console.log(`settings schema regenerated → ${outPath}`)

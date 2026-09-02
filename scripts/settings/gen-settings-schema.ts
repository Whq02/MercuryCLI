#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/gen-settings-schema.ts — the committed review snapshot of
//  Mercury's OWN settings JSON schema (own-naming lane).
//
//  The schema is GENERATED from the live validator source (SettingsSchema →
//  schemaOutput.generateSettingsJSONSchema) — the same call the runtime makes
//  when it refreshes <config-home>/schema/settings.schema.json
//  (src/utils/settings/localSchema.ts). This snapshot exists for review
//  visibility and the drift pin: a settings-schema change shows up in the
//  diff, and prove-settings-schema.ts goes red when the snapshot is stale.
//
//  Output: scripts/settings/settings-schema.json (tracked; regenerate here),
//  or the path given as --out <path> (the prover's scratch copy).
// ============================================================================
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

#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-settings-schema.ts — Mercury's OWN settings schema
//  (own-naming lane): generated from the validator source, shipped local,
//  referenced by written settings files.
//
//  Pins:
//    1. DRIFT: the committed snapshot (settings-schema.json) byte-matches a
//       fresh generation from the live SettingsSchema — a schema change
//       without `bun scripts/settings/gen-settings-schema.ts` is red. The
//       generation is deterministic (two runs agree).
//    2. REAL SCHEMA: ajv (draft 2020-12) compiles the generated schema; a
//       canonical Mercury settings fixture VALIDATES.
//    3. DISCRIMINATES: a foreign-shaped settings document (record fields as
//       arrays, object fields as scalars) is REJECTED — the poison is a
//       schema so loose it validates anything.
//    4. LOCAL POINTER: a userSettings write through the real pipeline stamps
//       `$schema` with <config-home>/schema/settings.schema.json, writes that
//       schema file, and the written settings document validates against it.
//    5. LEGACY ARM: a settings file still carrying the retired schemastore
//       URL keeps validating (the pointer is an editor affordance, not a
//       trust boundary).
//
//  Run:  ~/.bun/bin/bun run scripts/settings/prove-settings-schema.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.log(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// Scratch home BEFORE any src import samples the environment.
const scratchHome = mkdtempSync(join(tmpdir(), 'ownname-schema-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.CLAUDE_CONFIG_DIR

const { generateSettingsJSONSchema } = await import('../../src/utils/settings/schemaOutput.js')
const { ensureLocalSettingsSchema, settingsSchemaLocalPath } = await import(
  '../../src/utils/settings/localSchema.js'
)
const { updateSettingsForSource, getSettingsWriteFilePathForSource } = await import(
  '../../src/utils/settings/settings.js'
)
const { SettingsSchema } = await import('../../src/utils/settings/types.js')
const { default: Ajv2020 } = await import('ajv/dist/2020.js')

try {
  // --- 1. drift + determinism -----------------------------------------------
  const generatedA = `${generateSettingsJSONSchema()}\n`
  const generatedB = `${generateSettingsJSONSchema()}\n`
  check('generation is deterministic', generatedA === generatedB)
  const committedPath = join(import.meta.dir, 'settings-schema.json')
  let committed: string | null = null
  try {
    committed = readFileSync(committedPath, 'utf8')
  } catch {
    committed = null
  }
  check(
    'committed snapshot matches the live validator source',
    committed === generatedA,
    'regenerate: bun scripts/settings/gen-settings-schema.ts',
  )

  // --- 2 + 3. the schema is real and discriminates --------------------------
  const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false })
  const validate = ajv.compile(JSON.parse(generatedA) as object)
  const canonical = {
    $schema: settingsSchemaLocalPath(),
    model: 'opusplan',
    effortLevel: 'high',
    permissions: { allow: ['Read'], defaultMode: 'default' },
    env: { FOO: 'bar' },
    spinnerTipsEnabled: false,
  }
  check('canonical Mercury settings validate', validate(canonical) === true, JSON.stringify(validate.errors ?? []).slice(0, 300))
  const foreignShaped = {
    env: ['FOO=bar'],
    hooks: 'on',
    permissions: 'allow-all',
  }
  check('a foreign-shaped document is rejected', validate(foreignShaped) === false, 'the generated schema accepted record-as-array and object-as-string shapes')

  // --- 4. the write pipeline stamps the LOCAL pointer ------------------------
  const wrote = updateSettingsForSource('userSettings', { model: 'opusplan' })
  check('userSettings write succeeds in the scratch home', wrote.error === null, String(wrote.error))
  const writePath = getSettingsWriteFilePathForSource('userSettings')
  check('write path resolves inside the scratch home', writePath !== undefined && writePath.startsWith(scratchHome), String(writePath))
  const writtenRaw = readFileSync(writePath as string, 'utf8')
  const written = JSON.parse(writtenRaw) as { $schema?: string; model?: string }
  const localPath = settingsSchemaLocalPath()
  check('written settings reference the local schema', written.$schema === localPath, `$schema=${String(written.$schema)}`)
  check('the local schema path lives inside the config home', localPath.startsWith(scratchHome), localPath)
  let localSchemaRaw: string | null = null
  try {
    localSchemaRaw = readFileSync(localPath, 'utf8')
  } catch {
    localSchemaRaw = null
  }
  check('the local schema file exists after the write', localSchemaRaw !== null)
  check('the local schema file is the generated schema', localSchemaRaw === generatedA)
  if (localSchemaRaw !== null) {
    const validateLocal = new Ajv2020({ strict: false, logger: false }).compile(JSON.parse(localSchemaRaw) as object)
    check('the written settings file validates against the local schema', validateLocal(written) === true, JSON.stringify(validateLocal.errors ?? []).slice(0, 300))
  }
  check('ensureLocalSettingsSchema is idempotent', ensureLocalSettingsSchema() === localPath)

  // --- 5. legacy arm ---------------------------------------------------------
  const legacy = SettingsSchema().safeParse({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    model: 'opusplan',
  })
  check('a file carrying the retired schemastore pointer still validates', legacy.success)
} finally {
  rmSync(scratchHome, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`prove-settings-schema: ${failures} RED`)
  process.exit(1)
}
console.log('prove-settings-schema: all pins green')

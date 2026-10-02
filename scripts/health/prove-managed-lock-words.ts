#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(realpathSync(tmpdir()), 'managed-lock-words-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const fsOps = await import('../../src/utils/fsOperations.ts')
const { getManagedFilePath } = await import('../../src/utils/settings/managedPath.ts')
const { detectManagedSettingsWarnings } = await import('../../src/utils/healthDiagnostic.ts')
const { ExtensionsSettingsSchema } = await import('../../src/utils/settings/types.ts')

const policyPath = join(getManagedFilePath(), 'managed-settings.json')
const real = fsOps.getFsImplementation()
const plant = (text: string): void => {
  fsOps.setFsImplementation({
    ...real,
    readFileSync: ((path: string, options?: unknown) => (path === policyPath ? text : (real.readFileSync as (p: string, o?: unknown) => unknown)(path, options))) as never,
  } as never)
}

console.log('the managed lock: /health describes an invalid extensions.exclusive the way the settings reader treats it')
try {
  plant(JSON.stringify({ extensions: { exclusive: 42 } }))
  const warnings = detectManagedSettingsWarnings()
  const invalid = warnings.find(w => w.issue.includes('extensions.exclusive has an invalid value'))
  check('an invalid value is reported', invalid !== undefined, JSON.stringify(warnings))
  const read = ExtensionsSettingsSchema().parse({ exclusive: 42 }) as { exclusive?: unknown }
  check('the settings reader treats the invalid value as a full lock', read.exclusive === true, JSON.stringify(read))
  check('the fix line says the same — a full lock, never "ignored"', (invalid?.fix ?? '').includes('reads as a full lock') && !/ignored/.test(invalid?.fix ?? ''), invalid?.fix ?? '(none)')
  check('the fix line still teaches the accepted forms', (invalid?.fix ?? '').includes('Acceptable forms: true, or an array of surface names'))

  plant(JSON.stringify({ extensions: { exclusive: ['skills', 'frobnicate'] } }))
  const unrecognised = detectManagedSettingsWarnings().find(w => w.issue.includes('unrecognised surface name'))
  const filtered = ExtensionsSettingsSchema().parse({ exclusive: ['skills', 'frobnicate'] }) as { exclusive?: unknown }
  check('an unrecognised surface name is reported and the reader drops it, keeping the rest — the fix line says ignored, which is true here', unrecognised !== undefined && JSON.stringify(filtered.exclusive) === '["skills"]' && (unrecognised?.fix ?? '').includes('ignored'), JSON.stringify({ unrecognised, filtered }))
} finally {
  fsOps.setFsImplementation(real)
}

console.log(`\n${failures === 0 ? 'prove-managed-lock-words: ALL LAWS HOLD' : `prove-managed-lock-words: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

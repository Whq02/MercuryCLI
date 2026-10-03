#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(realpathSync(tmpdir()), 'settings-tip-words-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { getValidationTip } = await import('../../src/utils/settings/validationTips.ts')
const { PERMISSION_MODES } = await import('../../src/utils/permissions/PermissionMode.ts')
const { validateInputForSettingsFileEdit } = await import('../../src/utils/settings/validateEditTool.ts')
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')

console.log('§1 the guardrails.mode tip names every mode the schema accepts, in the schema\'s order')
{
  const tip = getValidationTip({ path: 'guardrails.mode', code: 'invalid_value' })
  const suggestion = tip?.suggestion ?? ''
  const accepted = (SettingsSchema().shape.guardrails as { unwrap(): { shape: { mode: { unwrap(): { options: readonly string[] } } } } }).unwrap().shape.mode.unwrap().options
  check('the schema accepts the PERMISSION_MODES list', JSON.stringify([...accepted]) === JSON.stringify([...PERMISSION_MODES]), JSON.stringify(accepted))
  const quoted = [...suggestion.matchAll(/"([a-zA-Z]+)"/g)].map(m => m[1])
  check('the tip quotes exactly the accepted modes, in order', JSON.stringify(quoted) === JSON.stringify([...accepted]), suggestion)
  for (const mode of accepted) check(`"${mode}" carries a gloss`, new RegExp(`"${mode}" \\([^)]+\\)`).test(suggestion), suggestion)
}

console.log('§2 the settings-edit refusal the model reads names the environment.values block')
{
  const file = join(HOME, 'settings.json')
  const refusal = validateInputForSettingsFileEdit(file, '{}', () => '{"guardrails": {"mode": "nonsense"}}')
  check('a valid file edited into an invalid one is refused with error code 10', refusal !== null && refusal.result === false && refusal.errorCode === 10)
  const message = refusal?.message ?? ''
  check('the refusal names the environment.values block', message.includes('Do not modify the environment.values block of a settings file unless the user explicitly asked for it.'), message.slice(-160))
  check('…and no block by another name', !/\benv block\b/.test(message), message.slice(-160))
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-tip-words: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-tip-words: all green')

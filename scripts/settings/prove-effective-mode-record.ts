import '../lib/hermetic.js'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = process.argv[2] ?? join(import.meta.dir, '../..')
const state = await import(join(root, 'src/bootstrap/state.ts'))
const setup = await import(join(root, 'src/utils/permissions/permissionSetup.ts'))
const derived = await import(join(root, 'src/utils/config/derived.ts'))
const settings = await import(join(root, 'src/utils/settings/settings.ts'))
let failures = 0
const check = (label: string, value: boolean) => {
  console.log(`[${value ? 'PASS' : 'FAIL'}] ${label}`)
  if (!value) failures++
}

const read = derived.getEffectivePermissionMode
check('the config model reads the actual session mode and its recorded source', typeof read === 'function')
if (typeof read === 'function') {
  settings.updateSettingsForSource('userSettings', { guardrails: { mode: 'default' } })
  setup.initialPermissionModeFromCLI({ dangerouslySkipPermissions: true })
  check('a sovereign boot reads Sovereign from the launch flag while the saved switch remains default', read('sovereign').mode === 'sovereign' && read('sovereign').source === 'launch-flag' && settings.getInitialSettings().guardrails?.mode === 'default')
  settings.updateSettingsForSource('userSettings', { guardrails: { mode: 'apollo' } })
  check('editing the next-boot setting cannot rewrite this session birth record', read('sovereign').source === 'launch-flag')
  check('a runtime mode change names the session choice rather than its old launch source', read('implement').source === 'session-choice')
  process.env.MERCURY_SKIP_PERMISSIONS = '1'
  setup.initialPermissionModeFromCLI({ dangerouslySkipPermissions: true })
  check('standing consent survives on the boot record', read('sovereign').source === 'session-birth')
  delete process.env.MERCURY_SKIP_PERMISSIONS
  settings.updateSettingsForSource('userSettings', { guardrails: { mode: 'default' } })
  setup.initialPermissionModeFromCLI({ dangerouslySkipPermissions: false })
  check('an explicitly saved default retains the settings source', read('default').source === 'saved-settings')
  state.resetStateForTests()
  check('reset rebuilds the posture owner without a previous session mode', state.getSessionPermissionModeResolution() === null)
}
console.log(failures === 0 ? 'prove-effective-mode-record: all green' : `prove-effective-mode-record: ${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

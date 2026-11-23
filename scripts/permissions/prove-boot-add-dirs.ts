#!/usr/bin/env bun
// gate-watch: src/platform/settings/settingsSchema.ts src/platform/settings/settings.ts src/permissions/rules/permissionSetup.ts src/tools/kit/tool.ts src/permissions/rules/permissions.ts
// gate-watch: src/commands/catalogue/commands.ts src/boot/main.tsx src/daemon/switchboard/runnerArgv.ts src/engine/requestContext.ts src/integrations/skills/loadSkillsDir.ts src/boot/process-state/processState.ts
// gate-watch: src/permissions/cards/rule-manager/PermissionRuleList.tsx src/sessions/instructions/instructionFiles.ts docs/TRUST.md
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'starting-folder-estate-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home)
mkdirSync(project)
const cwd = process.cwd()
process.chdir(project)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
try {
  const { PermissionsSchema } = await import('../../src/platform/settings/settingsSchema.js')
  for (const value of [[scratch], 'old-invalid-value', null, 17]) {
    const parsed = PermissionsSchema().safeParse({ mode: 'implement', additionalDirectories: value })
    check('a saved directory key is accepted without validation errors, like any unknown key', parsed.success, JSON.stringify(value), 'PermissionsSchema in src/platform/settings/settingsSchema.ts must not validate or reject an additionalDirectories key')
    check('the declared guardrail beside it applies', parsed.success && parsed.data.mode === 'implement', '', 'PermissionsSchema in src/platform/settings/settingsSchema.ts must still parse mode beside a saved additionalDirectories key')
  }
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { additionalDirectories: [scratch], mode: 'implement' } }))
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const { getSettingsWithErrors } = await import('../../src/platform/settings/settings.js')
  const loaded = getSettingsWithErrors()
  check('a settings file carrying a saved directory boots without errors', loaded.errors.length === 0, JSON.stringify(loaded.errors), 'getSettingsWithErrors in src/platform/settings/settings.ts must not report an error for a saved additionalDirectories key under guardrails')
  check('the declared guardrail mode is read', loaded.settings.guardrails?.mode === 'implement', '', 'getSettingsWithErrors in src/platform/settings/settings.ts must still read guardrails.mode from the settings file')
  const { initializeToolPermissionContext } = await import('../../src/permissions/rules/permissionSetup.js')
  const init = await initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'implement', allowDangerouslySkipPermissions: false })
  check('the live context has no added-root map', !Object.hasOwn(init.toolPermissionContext, 'additionalWorkingDirectories'), '', 'initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts must not build an additionalWorkingDirectories map')
  check('boot has no directory admission pass', !Object.hasOwn(init, 'admittedDirectories'), '', 'initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts must not return an admittedDirectories pass')
  const dist = join(repo, 'dist/mercury.mjs')
  check('the CLI artifact is available', existsSync(dist), '', 'run bun run build.ts to write dist/mercury.mjs before this proof')
  if (existsSync(dist)) {
    const result = spawnSync('node', [dist, '--add-dir'], {
      cwd: project,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    check('the CLI refuses --add-dir as an unknown option before any request', result.status !== 0 && /unknown option ['"]--add-dir['"]/.test(result.stderr + result.stdout), (result.stderr + result.stdout).slice(0, 250), 'the built CLI must not register an --add-dir option: remove it from the command definition, then rebuild with bun run build.ts')
  }
  console.log(`starting-folder-estate: ${passed} passed, ${failed} failed`)
} finally {
  process.chdir(cwd)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

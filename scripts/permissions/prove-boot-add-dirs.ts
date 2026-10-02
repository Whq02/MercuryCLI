#!/usr/bin/env bun
// gate-watch: src/utils/settings/types.ts src/utils/settings/settings.ts src/utils/permissions/permissionSetup.ts src/Tool.ts src/types/permissions.ts
// gate-watch: src/commands.ts src/main.tsx src/services/switchboard/runnerArgv.ts src/context.ts src/skills/loadSkillsDir.ts src/bootstrap/state.ts
// gate-watch: src/components/permissions/rules/PermissionRuleList.tsx src/services/instructions/engine.ts docs/TRUST.md
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const source = (file: string): string => readFileSync(join(repo, file), 'utf8')
try {
  const { PermissionsSchema } = await import('../../src/utils/settings/types.js')
  for (const value of [[scratch], 'old-invalid-value', null, 17]) {
    const parsed = PermissionsSchema().safeParse({ mode: 'implement', additionalDirectories: value })
    check('a saved directory key is accepted without validation errors, like any unknown key', parsed.success, JSON.stringify(value))
    check('the declared guardrail beside it applies', parsed.success && parsed.data.mode === 'implement')
  }
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { additionalDirectories: [scratch], mode: 'implement' } }))
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { getSettingsWithErrors } = await import('../../src/utils/settings/settings.js')
  const loaded = getSettingsWithErrors()
  check('a settings file carrying a saved directory boots without errors', loaded.errors.length === 0, JSON.stringify(loaded.errors))
  check('the declared guardrail mode is read', loaded.settings.guardrails?.mode === 'implement')
  check('no settings reader names a saved directory key', !/additionalDirectories/.test(source('src/utils/settings/types.ts')) && !/additionalDirectories/.test(source('src/utils/settings/settings.ts')))
  const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.js')
  const init = await initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'implement', allowDangerouslySkipPermissions: false })
  check('the live context has no added-root map', !Object.hasOwn(init.toolPermissionContext, 'additionalWorkingDirectories'))
  check('boot has no directory admission pass', !Object.hasOwn(init, 'admittedDirectories'))
  for (const file of [
    'src/Tool.ts', 'src/types/permissions.ts', 'src/commands.ts', 'src/main.tsx',
    'src/services/switchboard/runnerArgv.ts', 'src/context.ts', 'src/skills/loadSkillsDir.ts',
    'src/components/permissions/rules/PermissionRuleList.tsx', 'src/services/instructions/engine.ts',
  ]) {
    check(`${file}: no added-directory surface or reader`, !/additionalWorkingDirectories|--add-dir|\/add-dir|AddWorkspaceDirectory|getAddedDirectories/.test(source(file)))
  }
  check('the workspace permission tab is absent', !source('src/components/permissions/rules/PermissionRuleList.tsx').includes('id="workspace"'))
  const trust = source('docs/TRUST.md')
  check('the docs name the starting-folder law', /starting folder/i.test(trust) && /Implement mode/.test(trust) && /outside/.test(trust))
  const dist = join(repo, 'dist/mercury.mjs')
  check('the CLI artifact is available', existsSync(dist))
  if (existsSync(dist)) {
    const result = spawnSync('node', [dist, '--add-dir'], {
      cwd: project,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    check('the CLI refuses --add-dir as an unknown option before any request', result.status !== 0 && /unknown option ['"]--add-dir['"]/.test(result.stderr + result.stdout), (result.stderr + result.stdout).slice(0, 250))
  }
  console.log(`starting-folder-estate: ${passed} passed, ${failed} failed`)
} finally {
  process.chdir(cwd)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

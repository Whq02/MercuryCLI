#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'flow-broad-rules-')))
const HOME = join(SCRATCH, 'home')
const FOLDER = join(SCRATCH, 'folder')
for (const dir of [HOME, FOLDER]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
for (const key of ['MERCURY_HOME', 'MERCURY_BARE']) delete process.env[key]
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const USER_SETTINGS = join(HOME, 'settings.json')
const BROAD = 'Bash(*)'
const NARROW = 'Read(docs/**)'
writeFileSync(USER_SETTINGS, JSON.stringify({ guardrails: { allow: [BROAD] } }))

const state = await import(join(SRC, 'bootstrap/state.ts'))
const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
setCwd(FOLDER)
state.setOriginalCwd(FOLDER)
state.setProjectRoot(FOLDER)
state.setIsInteractive(true)
state.setSessionTrustAccepted(true)
const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))
const { applyPermissionRulesToPermissionContext } = await import(join(SRC, 'utils/permissions/permissions.ts'))
const { loadAllPermissionRulesFromDisk } = await import(join(SRC, 'utils/permissions/permissionsLoader.ts'))
const setup = await import(join(SRC, 'utils/permissions/permissionSetup.ts'))
const { applySettingsChange } = await import(join(SRC, 'utils/settings/applySettingsChange.ts'))
const { resetSettingsCache } = await import(join(SRC, 'utils/settings/settingsCache.ts'))
enableConfigs()

type Context = { mode: string; alwaysAllowRules: Record<string, string[] | undefined>; strippedDangerousRules?: Record<string, string[]> }
const allowed = (context: Context): string => (context.alwaysAllowRules.userSettings ?? []).join(',') || '(none)'
const aside = (context: Context): string => (context.strippedDangerousRules?.userSettings ?? []).join(',') || '(none)'
const broadIn = (list: string): boolean => list.split(',').some(rule => rule === 'Bash' || rule === BROAD)

console.log('============================================================')
console.log(' Flow keeps a broad allow rule set aside when a settings file changes')
console.log('============================================================')

section('§0 the page')
check('the page says broad dangerous allow rules are set aside while Flow is on', /Broad\s+dangerous\s+allow\s+rules\s+are\s+set\s+aside\s+while\s+Flow\s+is\s+on/.test(readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8')))

section('§1 a session in Flow whose user settings allow every Bash command')
const booted = setup.stripDangerousPermissionsForFlow({ ...applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), loadAllPermissionRulesFromDisk()), mode: 'flow' }) as Context
check('control: at the start the broad rule is set aside and not in force', !broadIn(allowed(booted)) && broadIn(aside(booted)), `in force ${allowed(booted)} · aside ${aside(booted)}`)

section('§2 a settings file changes while Flow is on')
let app = { toolPermissionContext: booted, settings: {} } as { toolPermissionContext: Context; settings: unknown }
const setAppState = (updater: (prev: typeof app) => typeof app): void => {
  app = updater(app)
}
writeFileSync(USER_SETTINGS, JSON.stringify({ guardrails: { allow: [BROAD, NARROW] }, engine: { effort: 'high' } }))
resetSettingsCache()
applySettingsChange('userSettings', setAppState as never)
const after = app.toolPermissionContext
check('the broad rule the change read back from disk is still not in force', !broadIn(allowed(after)), `in force ${allowed(after)}`)
check('a narrow rule the same change added is in force: the change itself was applied', allowed(after).split(',').includes(NARROW), `in force ${allowed(after)}`)
check('the broad rule is kept aside once, not once per change', aside(after).split(',').filter(rule => broadIn(rule)).length === 1, `aside ${aside(after)}`)
resetSettingsCache()
applySettingsChange('userSettings', setAppState as never)
check('a second change leaves it aside once still', aside(app.toolPermissionContext).split(',').filter(rule => broadIn(rule)).length === 1 && !broadIn(allowed(app.toolPermissionContext)), `in force ${allowed(app.toolPermissionContext)} · aside ${aside(app.toolPermissionContext)}`)

section('§3 leaving Flow gives the rule back, once')
{
  const left = setup.transitionPermissionMode('flow', 'default', app.toolPermissionContext) as Context
  const inForce = allowed(left).split(',')
  check('outside Flow the broad rule is in force again, once', inForce.filter(rule => broadIn(rule)).length === 1 && inForce.includes(NARROW), `in force ${allowed(left)}`)
}

section('§4 another mode is not touched')
{
  let other = { toolPermissionContext: { ...applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), loadAllPermissionRulesFromDisk()), mode: 'default' } as Context, settings: {} }
  resetSettingsCache()
  applySettingsChange('userSettings', ((updater: (prev: typeof other) => typeof other) => {
    other = updater(other)
  }) as never)
  check('in Default mode a settings change leaves the broad rule in force', broadIn(allowed(other.toolPermissionContext)), `in force ${allowed(other.toolPermissionContext)}`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ flow keeps broad rules aside: ${checks} checks, 0 failures` : ` ❌ flow keeps broad rules aside: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)

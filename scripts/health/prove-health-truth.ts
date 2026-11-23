#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'health-truth-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
writeFileSync(join(home, 'settings.json'), '{ "model": ')
mkdirSync(join(home, 'history.jsonl'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { healthContext } = await import('../../src/platform/health/healthReport.ts')
const { HEALTH_SECTIONS } = await import('../../src/platform/health/sections.ts')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
const { getRipgrepStatus } = await import('../../src/platform/shell/ripgrep.ts')
const context = await healthContext()
const rows = new Map((await Promise.all(HEALTH_SECTIONS.map(entry => entry.checks(context)))).flat().map(row => [row.id, row]))
const run = async (id: string) => rows.get(id)!.run()

const { getSettingsWithAllErrors } = await import('../../src/platform/settings-faults/allErrors.ts')
const settingsRow = await run('settings')
const settingsErrors = getSettingsWithAllErrors().errors
const firstError = settingsErrors[0]
t('settings errors compose file · path · message', firstError !== undefined && String(firstError.file).endsWith('settings.json') && String(firstError.message).length > 0 && settingsRow.status === 'warn' && settingsRow.evidence === `${settingsErrors.length} settings validation error(s) — first: ${[firstError.file, firstError.path, firstError.message].filter(Boolean).join(' · ').slice(0, 120)}`, settingsRow.evidence)
t('…the phantom .error cast is dead', !/undefined|\[object/.test(settingsRow.evidence), settingsRow.evidence)

const plain = FLAG_REGISTRY.find(f => f.selfStamped !== true)!
const stamped = FLAG_REGISTRY.find(f => f.selfStamped === true)!
const before = { plain: process.env[plain.env], stamped: process.env[stamped.env] }
process.env[plain.env] = 'abcdefghijklmnopqrst'
process.env[stamped.env] = 'stamped-value'
const flagsRow = await run('flags')
for (const [env, value] of [[plain.env, before.plain], [stamped.env, before.stamped]] as const) {
  if (value === undefined) delete process.env[env]
  else process.env[env] = value
}
t('env values name their cut', flagsRow.evidence.includes(`${plain.env}=abcdefghijkl…`), flagsRow.evidence)
t('the boot self-stamp never counts as an override', flagsRow.evidence.includes('self-stamped (not an override): ') && flagsRow.evidence.includes(`${stamped.env}=stamped-valu`) && !(flagsRow.detail ?? '').includes(`${stamped.env}=`), flagsRow.evidence)

const slots = await run('provider-slots')
t('the ROUTER row says configured, never LIVE', slots.evidence.startsWith('anthropic configured (') && !/\bLIVE\b/.test(slots.evidence), slots.evidence)

const blocked = await run('history')
t('the history row fails a directory-shaped store', blocked.status !== 'ok' && blocked.evidence.startsWith('history.jsonl is a DIRECTORY'), `${blocked.status}: ${blocked.evidence}`)
rmdirSync(join(home, 'history.jsonl'))

const runtimeRow = await run('runtime')
const rg = getRipgrepStatus()
t('ripgrep presence is the status fact, never existsSync of the bare name', runtimeRow.evidence.includes(`ripgrep ${rg.mode} @ ${basename(rg.path)} ${rg.present ? 'present' : 'MISSING'}`), runtimeRow.evidence)

const platformNow = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { ...platformNow, value: 'win32' })
let onWindows: { evidence: string } | undefined
try {
  onWindows = await run('resources')
} catch {
  onWindows = undefined
} finally {
  Object.defineProperty(process, 'platform', platformNow)
}
t('win32 names its unreadable load', onWindows?.evidence.includes('load n/a (win32 has no loadavg)') === true, onWindows?.evidence)

console.log(failures === 0 ? 'HEALTH TRUTH: ALL PASS' : 'HEALTH TRUTH: RED')
process.exit(failures)

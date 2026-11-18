#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'health-truth-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
writeFileSync(join(home, 'settings.json'), '{ "model": ')
mkdirSync(join(home, 'history.jsonl'))
const gauge = readFileSync(join(ROOT, 'src/utils/cockpit/mcpGauge.ts'), 'utf8')
const settings = readFileSync(join(ROOT, 'src/utils/settings/settings.ts'), 'utf8')
const history = readFileSync(join(ROOT, 'src/history.ts'), 'utf8')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { healthContext } = await import('../../src/utils/healthReport.ts')
const { HEALTH_SECTIONS } = await import('../../src/utils/health/sections.ts')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
const { getRipgrepStatus } = await import('../../src/utils/ripgrep.ts')
const context = await healthContext()
const rows = new Map((await Promise.all(HEALTH_SECTIONS.map(entry => entry.checks(context)))).flat().map(row => [row.id, row]))
const run = async (id: string) => rows.get(id)!.run()

const { getSettingsWithAllErrors } = await import('../../src/utils/settings/allErrors.ts')
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
const quiet = await run('history')
t('…and says when nothing was tried', quiet.status === 'ok' && quiet.evidence.startsWith('no append attempted this run') && history.includes('historyEverFlushedThisProcess'), quiet.evidence)

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
t('the mcp gauge reads the checked-in project file', gauge.includes('getProjectMcpConfigsFromCwd()'))
t('an unreadable settings file is a NAMED error', settings.includes('settings file unreadable:'))

console.log(failures === 0 ? 'HEALTH TRUTH: ALL PASS' : 'HEALTH TRUTH: RED')
process.exit(failures)

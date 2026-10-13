#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = mkdtempSync(join(tmpdir(), 'entry-knapsack-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

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
const j = (v: unknown): string => JSON.stringify(v)
const ROOT = join(import.meta.dir, '..', '..')

const PROMPT_SIZE_B33 = 7499

const usage = await import('../../src/mneme/mnemeUsage.ts')
const settings = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

section('§1 one budget for what memory sends at start: a named constant under the .33 prompt size, a setting beside the pinned limit')
{
  check(`the default start limit is ${usage.START_TEXT_LIMIT_DEFAULT} characters, under the ${PROMPT_SIZE_B33} the .33 prompt sent before the first message`, usage.START_TEXT_LIMIT_DEFAULT === 7000 && usage.START_TEXT_LIMIT_DEFAULT <= PROMPT_SIZE_B33)
  check('the limit moves by a thousand and never below a thousand', usage.START_TEXT_LIMIT_MIN === 1000 && usage.START_TEXT_LIMIT_STEP === 1000)
  check('with nothing set the limit is the default', usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT)
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 12500 } }))
  resetSettingsCache()
  check('memory.startLimit in settings is the limit', usage.startTextLimit() === 12500, String(usage.startTextLimit()))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 4321.9 } }))
  resetSettingsCache()
  check('a fraction is not an integer: the parser skips the value and the default stands', usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT && settings.parseSettingsFile(join(HOME, 'settings.json')).errors.some(e => e.path === 'memory.startLimit'), String(usage.startTextLimit()))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 200 } }))
  resetSettingsCache()
  check('a value under the floor is ignored for the default', usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT, String(usage.startTextLimit()))
  const parsed = settings.parseSettingsFile(join(HOME, 'settings.json'))
  check('the settings parser names the fault: at least 1000', parsed.errors.some(e => e.path === 'memory.startLimit' && /at least 1000/.test(e.message)), j(parsed.errors))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { pinnedLimit: 23000 } }))
  resetSettingsCache()
  check('the pinned limit and the start limit are two settings: a raised pinned limit leaves the start limit at its default', usage.pinnedTextLimit() === 23000 && usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT)
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
  resetSettingsCache()
  const schema = JSON.parse(readFileSync(join(ROOT, 'scripts/settings/settings-schema.json'), 'utf8')) as { properties?: { memory?: { properties?: Record<string, { type?: string; minimum?: number; description?: string }> } } }
  const row = schema.properties?.memory?.properties?.startLimit
  check('the generated settings schema carries memory.startLimit as an integer of at least 1000 with the default named', row?.type === 'integer' && row.minimum === 1000 && /default 7000/.test(row.description ?? ''), j(row))
  const config = readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8')
  check('the /config row sits in the pinned limit\'s family and writes the user setting', config.includes("id: 'memory.startLimit'") && config.includes("label: 'Memory at start'") && config.includes("writeSource('userSettings', { memory: { startLimit: next } })"))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ ENTRY KNAPSACK GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ENTRY KNAPSACK RED (${failures} of ${checks} checks failed)`)
process.exit(1)

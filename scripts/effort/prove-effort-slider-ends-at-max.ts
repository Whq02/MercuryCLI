#!/usr/bin/env bun
// gate-watch: src/commands/effort/EffortSlider.tsx src/commands/effort/effort.tsx src/commands/effort/index.ts
// gate-watch: src/commands.ts src/state/AppStateStore.ts src/utils/settings/settings.ts src/utils/settings/types.ts src/utils/effort.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.NODE_ENV = 'test'
const scratch = mkdtempSync(join(tmpdir(), 'effort-rail-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const slider = await import('../../src/commands/effort/EffortSlider.js')
const cmd = await import('../../src/commands/effort/effort.js')
const effortCommand = (await import('../../src/commands/effort/index.js')).default
const store = await import('../../src/state/AppStateStore.js')
const settings = await import('../../src/utils/settings/settings.js')
const commands = await import('../../src/commands.js')

console.log('— the rail: five stops, the last one max, for every model that serves max —')
for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5-5']) {
  const geo = slider.getSliderGeometry(model)
  const words = geo.levels.map(l => String(l.value))
  t(`${model}: the stops are the ladder and end at max`, words.join(',') === 'low,medium,high,xhigh,max', words.join(','))
  t(`${model}: five triangle columns on a ${geo.width}-wide rail, no junction`, geo.trianglePositions.length === 5 && geo.width === 53 && !geo.trackChars.includes('┆'), `${geo.trianglePositions.length} stops · ${geo.trackChars}`)
  t(`${model}: the rail carries no caption under a sixth stop`, !('sublabel' in geo) && !('accentStart' in geo))
  const opens = slider.resolveOpeningStop(model, 'max')
  t(`${model}: a session at max opens on the last stop`, opens === geo.levels.length - 1 && geo.levels[opens]?.value === 'max', String(opens))
}

console.log('— the words: /effort offers the ladder and auto, nothing after max —')
t('the argument hint ends at max before auto', effortCommand.argumentHint === '[low|medium|high|xhigh|max|auto]', String(effortCommand.argumentHint))
const unknownA = cmd.executeEffort('supercode', 'claude-opus-5')
const unknownB = cmd.executeEffort('frobnicate', 'claude-opus-5')
t('"/effort supercode" answers exactly as "/effort frobnicate" does, word for word', unknownA.message.replace('supercode', 'frobnicate') === unknownB.message, `${unknownA.message} | ${unknownB.message}`)
t('…and the answer names the ladder up to max and auto', unknownB.message.startsWith('Valid options: low|medium|high|xhigh|max|auto —'), unknownB.message)
t('…and neither answer changes the effort', unknownA.effortUpdate === undefined && unknownB.effortUpdate === undefined)
t('…and the result shape carries no mode field', !('supercodeUpdate' in unknownA))

console.log('— the state: the app state holds an effort value and no mode flag —')
t('getDefaultAppState has no supercode key', !('supercode' in store.getDefaultAppState()))

console.log('— the settings: a stored mode key is an unknown key like any other —')
const home = process.env.MERCURY_CONFIG_DIR
const settingsPath = join(home, 'settings.json')
writeFileSync(settingsPath, JSON.stringify({ engine: { supercode: true, frobnicate: true, effort: 'high' }, supercodeEffort: true, ultracodeEffort: true }, null, 2))
const w = settings.updateSettingsForSource('userSettings', { engine: { effort: 'xhigh' } })
t('a write beside the stored keys lands', w.error === null, String(w.error))
const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: Record<string, unknown>; supercodeEffort?: unknown; ultracodeEffort?: unknown }
t('the stored keys are treated alike: each stays as written, none is rewritten, none is adopted', raw.engine?.supercode === true && raw.engine?.frobnicate === true && raw.supercodeEffort === true && raw.ultracodeEffort === true && raw.engine?.effort === 'xhigh', JSON.stringify(raw))
const typed = settings.getInitialSettings() as { engine?: Record<string, unknown> }
t('the typed read carries the ladder word and treats the stored mode keys alike', typed.engine?.effort === 'xhigh' && ('supercode' in (typed.engine ?? {})) === ('frobnicate' in (typed.engine ?? {})), JSON.stringify(typed.engine))
const typesSrc = readFileSync(join(ROOT, 'src/utils/settings/types.ts'), 'utf8')
t('the settings schema declares no supercode key', !/supercode/i.test(typesSrc))
const settingsSrc = readFileSync(join(ROOT, 'src/utils/settings/settings.ts'), 'utf8')
t('the settings loader carries no rewrite between stored spellings of a mode key', !/ultracode|supercode/i.test(settingsSrc))
const effortSrc = readFileSync(join(ROOT, 'src/utils/effort.ts'), 'utf8')
t('the effort reader reads one engine key and no mode flag', effortSrc.includes('engine?.effort') && !/supercode/i.test(effortSrc))

console.log('— the command roster: /supercode is unknown like /frobnicate —')
const names = new Set((await commands.getCommands('.')).map((c: { name: string }) => c.name))
t('no command named supercode is registered', !names.has('supercode'))
if (!existsSync(DIST)) {
  t('the bundle is built (bun run build.ts; MERCURY_PROOF_BUNDLE points elsewhere)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    t('a node binary on PATH', false)
  } else {
    const cwd = mkdtempSync(join(tmpdir(), 'effort-rail-cwd-'))
    const env: Record<string, string> = {
      HOME: scratch,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(scratch, 'door-home'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_CREWS_DIR: join(scratch, 'crews'),
    }
    mkdirSync(env.MERCURY_CONFIG_DIR!, { recursive: true })
    const run = (prompt: string) => spawnSync(nodeBin, [DIST, 'run', prompt, '--format', 'text', '--model', 'claude-opus-4-8'], { cwd, env, encoding: 'utf8', timeout: 90_000 })
    const a = run('/supercode')
    const b = run('/frobnicate')
    const norm = (s: string): string => s.replace(/supercode/g, 'frobnicate').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    t('"/supercode" exits as "/frobnicate" does', a.status === b.status && a.status !== null, `${a.status} vs ${b.status}`)
    t('"/supercode" writes what "/frobnicate" writes, word for word', norm(`${a.stdout}\n${a.stderr}`) === norm(`${b.stdout}\n${b.stderr}`), `${(a.stdout + a.stderr).slice(0, 200)} | ${(b.stdout + b.stderr).slice(0, 200)}`)
    t('the door answers the unknown command with words (not silence)', `${b.stdout}${b.stderr}`.trim().length > 0, `${b.stdout}${b.stderr}`.slice(0, 200))
  }
}

console.log(failures ? '\n❌ EFFORT-SLIDER-ENDS-AT-MAX RED' : '\n✅ EFFORT-SLIDER-ENDS-AT-MAX GREEN')
process.exit(failures)

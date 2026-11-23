#!/usr/bin/env bun
// gate-watch: src/commands/effort/EffortPopup.tsx src/commands/effort/effort.tsx src/commands/effort/index.ts
// gate-watch: src/commands/catalogue/commands.ts src/screen/app-state/AppStateStore.ts src/platform/settings/settings.ts src/platform/settings/settingsSchema.ts src/models/effort/effort.ts
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

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const popup = await import('../../src/commands/effort/EffortPopup.js')
const cmd = await import('../../src/commands/effort/effort.js')
const effortCommand = (await import('../../src/commands/effort/index.js')).default
const store = await import('../../src/screen/app-state/AppStateStore.js')
const settings = await import('../../src/platform/settings/settings.js')
const commands = await import('../../src/commands/catalogue/commands.js')

console.log('— the popup: auto then the ladder, the last row max, for every model that serves max —')
for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5-5']) {
  const rows = popup.effortPopupRows(model)
  const words = rows.map(row => String(row.value))
  t(`${model}: the rows are auto then the ladder and end at max`, words.join(',') === 'auto,low,medium,high,xhigh,max', `${words.join(',')} — effortPopupRows in src/commands/effort/EffortPopup.tsx must list auto then low,medium,high,xhigh,max for this model`)
  t(`${model}: every row carries its word and a one-line description, none a sixth tier`, rows.every(row => row.word === String(row.value) && row.description.length > 0) && !words.some(word => /ultra/i.test(word)), `rows: ${words.join(',')} — in effortPopupRows (src/commands/effort/EffortPopup.tsx) every row needs word equal to its value and a non-empty description, and no row may be an ultra tier`)
  t(`${model}: the last row is max`, rows[rows.length - 1]?.value === 'max', `${String(rows[rows.length - 1]?.value)} — effortPopupRows in src/commands/effort/EffortPopup.tsx must end with max for a model that serves max`)
  const opens = popup.effortPopupOpeningRow(model, 'max')
  t(`${model}: a session at max opens on the last row`, opens === rows.length - 1 && rows[opens]?.value === 'max', `${String(opens)} — effortPopupOpeningRow in src/commands/effort/EffortPopup.tsx must return the index of the max row (${rows.length - 1}) when the session effort is max`)
}
{
  const rows = popup.effortPopupRows('claude-sonnet-4-6')
  t('a max-yes/xhigh-no model lists no xhigh row: an unsupported tier is absent, never greyed', rows.map(row => String(row.value)).join(',') === 'auto,low,medium,high,max', `${rows.map(row => String(row.value)).join(',')} — effortPopupRows in src/commands/effort/EffortPopup.tsx must leave out xhigh for a model that does not support it`)
  t('…and its last row is still max', rows[rows.length - 1]?.value === 'max', `${String(rows[rows.length - 1]?.value)} — effortPopupRows in src/commands/effort/EffortPopup.tsx must end with max even when xhigh is left out`)
}

console.log('— the words: /effort offers the ladder and auto, nothing after max —')
t('the argument hint ends at max before auto', effortCommand.argumentHint === '[low|medium|high|xhigh|max|auto]', `${String(effortCommand.argumentHint)} — argumentHint in src/commands/effort/index.ts must read [low|medium|high|xhigh|max|auto]`)
const unknownA = cmd.executeEffort('supercode', 'claude-opus-5')
const unknownB = cmd.executeEffort('frobnicate', 'claude-opus-5')
t('"/effort supercode" answers exactly as "/effort frobnicate" does, word for word', unknownA.message.replace('supercode', 'frobnicate') === unknownB.message, `${unknownA.message} | ${unknownB.message} — executeEffort in src/commands/effort/effort.tsx must answer every unknown word with the same message, not one that special-cases the word`)
t('…and the answer names the ladder up to max and auto', unknownB.message.startsWith('Valid options: low|medium|high|xhigh|max|auto —'), `${unknownB.message} — executeEffort in src/commands/effort/effort.tsx must start its unknown-word answer with Valid options: low|medium|high|xhigh|max|auto —`)
t('…and neither answer changes the effort', unknownA.effortUpdate === undefined && unknownB.effortUpdate === undefined, 'executeEffort in src/commands/effort/effort.tsx must return no effortUpdate for an unknown word')
t('…and the result shape carries no mode field', !('supercodeUpdate' in unknownA), 'the result of executeEffort in src/commands/effort/effort.tsx must not carry a supercodeUpdate field')

console.log('— the state: the app state holds an effort value and no mode flag —')
t('getDefaultAppState has no supercode key', !('supercode' in store.getDefaultAppState()), 'getDefaultAppState in src/screen/app-state/AppStateStore.ts must not define a supercode key')

console.log('— the settings: a stored mode key is an unknown key like any other —')
const home = process.env.MERCURY_CONFIG_DIR
const settingsPath = join(home, 'settings.json')
writeFileSync(settingsPath, JSON.stringify({ engine: { supercode: true, frobnicate: true, effort: 'high' }, supercodeEffort: true, ultracodeEffort: true }, null, 2))
const w = settings.updateSettingsForSource('userSettings', { engine: { effort: 'xhigh' } })
t('a write beside the stored keys lands', w.error === null, `${String(w.error)} — updateSettingsForSource in src/platform/settings/settings.ts must accept a write of engine.effort beside stored unknown keys`)
const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: Record<string, unknown>; supercodeEffort?: unknown; ultracodeEffort?: unknown }
t('the stored keys are treated alike: each stays as written, none is rewritten, none is adopted', raw.engine?.supercode === true && raw.engine?.frobnicate === true && raw.supercodeEffort === true && raw.ultracodeEffort === true && raw.engine?.effort === 'xhigh', `${JSON.stringify(raw)} — updateSettingsForSource in src/platform/settings/settings.ts must leave the stored supercode, frobnicate, supercodeEffort and ultracodeEffort keys as written and set engine.effort to xhigh`)
const typed = settings.getInitialSettings() as { engine?: Record<string, unknown> }
t('the typed read carries the ladder word and treats the stored mode keys alike', typed.engine?.effort === 'xhigh' && ('supercode' in (typed.engine ?? {})) === ('frobnicate' in (typed.engine ?? {})), `${JSON.stringify(typed.engine)} — getInitialSettings in src/platform/settings/settings.ts must return engine.effort xhigh and treat a stored supercode key exactly like frobnicate (the schema in src/platform/settings/settingsSchema.ts must not name supercode)`)

console.log('— the command roster: /supercode is unknown like /frobnicate —')
const names = new Set((await commands.getCommands('.')).map((c: { name: string }) => c.name))
t('no command named supercode is registered', !names.has('supercode'), 'getCommands in src/commands/catalogue/commands.ts must not register a command named supercode')
if (!existsSync(DIST)) {
  t('the bundle is built (bun run build.ts; MERCURY_PROOF_BUNDLE points elsewhere)', false, `${DIST} — run bun run build.ts to write dist/mercury.mjs, or set MERCURY_PROOF_BUNDLE to a built bundle`)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    t('a node binary on PATH', false, 'install Node 24 and put node on PATH; this proof runs the built bundle with it')
  } else {
    const cwd = mkdtempSync(join(tmpdir(), 'effort-rail-cwd-'))
    const env: Record<string, string> = {
      HOME: scratch,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(scratch, 'door-home'),
      MERCURY_TMPDIR: join(scratch, 'temp'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    }
    mkdirSync(env.MERCURY_CONFIG_DIR!, { recursive: true })
    const run = (prompt: string) => spawnSync(nodeBin, [DIST, 'run', prompt, '--format', 'text', '--model', 'claude-opus-4-8'], { cwd, env, encoding: 'utf8', timeout: 90_000 })
    const a = run('/supercode')
    const b = run('/frobnicate')
    const norm = (s: string): string => s.replace(/supercode/g, 'frobnicate').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    t('"/supercode" exits as "/frobnicate" does', a.status === b.status && a.status !== null, `${a.status} vs ${b.status} — the built bundle (node dist/mercury.mjs run) must exit the same for an unknown slash command whatever its name; a null status means the run timed out or did not start`)
    t('"/supercode" writes what "/frobnicate" writes, word for word', norm(`${a.stdout}\n${a.stderr}`) === norm(`${b.stdout}\n${b.stderr}`), `${(a.stdout + a.stderr).slice(0, 200)} | ${(b.stdout + b.stderr).slice(0, 200)} — the run door must not treat the name supercode differently from frobnicate; the first 200 characters of each output differ after normalising`)
    t('the door answers the unknown command with words (not silence)', `${b.stdout}${b.stderr}`.trim().length > 0, `${b.stdout}${b.stderr}`.slice(0, 200) + ' — the built bundle must print a message for an unknown slash command run through node dist/mercury.mjs run, not stay silent')
  }
}

console.log(failures ? '\n❌ EFFORT-SLIDER-ENDS-AT-MAX RED' : '\n✅ EFFORT-SLIDER-ENDS-AT-MAX GREEN')
process.exit(failures)

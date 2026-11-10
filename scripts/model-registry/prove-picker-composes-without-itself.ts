#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const CHILD = join(import.meta.dir, 'pickerComposeChild.ts')
const BUDGET_MS = 30_000

interface Composed {
  ms: number
  rows: Array<{ value: string; label: string }>
  probeRows: number
  parsed: string | null
  spelled: string | null
  fable51: string
  engineModel: string
  name: string | null
  toggle: boolean | null
  standsAlone: boolean | null
}
type Outcome = { state: 'answered'; composed: Composed; wallMs: number } | { state: 'spent'; wallMs: number; signal: string | null; status: number | null; stderr: string }

function compose(name: string, settings: Record<string, unknown>, env: Record<string, string>, probe: string): Outcome {
  const home = mkdtempSync(join(tmpdir(), `picker-compose-${name}-`))
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  const out = join(home, 'composed.json')
  const childEnv: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, PICKER_COMPOSE_OUT: out, PICKER_COMPOSE_PROBE: probe, ...env }
  for (const key of ['MERCURY_MODEL', 'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN']) if (!(key in env)) delete childEnv[key]
  const started = Date.now()
  const run = spawnSync(process.execPath, [CHILD], { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: BUDGET_MS, killSignal: 'SIGKILL' })
  const wallMs = Date.now() - started
  if (run.status === 0 && existsSync(out)) return { state: 'answered', composed: JSON.parse(readFileSync(out, 'utf8')) as Composed, wallMs }
  return { state: 'spent', wallMs, signal: run.signal, status: run.status, stderr: (run.stderr ?? '').slice(-300) }
}
const show = (o: Outcome): string => (o.state === 'answered' ? JSON.stringify({ ...o.composed, rows: o.composed.rows.map(r => r.value) }) : JSON.stringify(o))

console.log('============================================================')
console.log(' composing the picker never consults the picker')
console.log(`   each scene is one child process with a ${BUDGET_MS / 1000} s budget: a scene that does not answer is a failure, never a wait`)
console.log('============================================================')

const OPAQUE = 'custom-fable-51-deployment'
const MARKED = 'us.anthropic.claude-fable-5-1-v1:0'

section('§1 the control: no pin')
const control = compose('control', {}, {}, '')
{
  check('the picker composes inside the budget', control.state === 'answered', show(control))
  check('…with Fable 5.1 as its own row under its id', control.state === 'answered' && control.composed.rows.some(r => r.value === 'claude-fable-5-1' && r.label === 'Fable 5.1'), show(control))
}

section("§2 engine.pins maps Fable 5.1 to an endpoint id that carries no vendor mark (docs/SETTINGS.md: 'the ids your endpoint serves')")
{
  const o = compose('opaque', { engine: { pins: { 'claude-fable-5-1': OPAQUE } } }, {}, OPAQUE)
  check('the picker composes inside the budget', o.state === 'answered', show(o))
  if (o.state === 'answered') {
    const c = o.composed
    check('the pinned row stands once, under the endpoint id, named Fable 5.1', c.probeRows === 1 && c.rows.filter(r => r.label === 'Fable 5.1').length === 1 && c.rows.find(r => r.label === 'Fable 5.1')?.value === OPAQUE, show(o))
    check('every other first-party row is the row the control has', control.state === 'answered' && JSON.stringify(c.rows.filter(r => r.value !== OPAQUE)) === JSON.stringify(control.composed.rows.filter(r => r.value !== 'claude-fable-5-1')), show(o))
    check('the endpoint id parses to itself, by the setting parser and by the spelling fold', c.parsed === OPAQUE && c.spelled === OPAQUE, show(o))
    check("the alias fable51 resolves to the endpoint id, and the row's name and 1M toggle answer", c.fable51 === OPAQUE && c.name === 'Fable 5.1' && c.toggle === false, show(o))
    check('the row is not folded onto another row', c.standsAlone === true, show(o))
    check('the session default resolves', typeof c.engineModel === 'string' && c.engineModel.length > 0, show(o))
  }
}

section('§3 the same pin with a vendor mark answers as it did')
{
  const o = compose('marked', { engine: { pins: { 'claude-fable-5-1': MARKED } } }, {}, MARKED)
  check('the picker composes inside the budget', o.state === 'answered', show(o))
  check('the pinned row stands once under the endpoint id, named Fable 5.1', o.state === 'answered' && o.composed.probeRows === 1 && o.composed.rows.find(r => r.label === 'Fable 5.1')?.value === MARKED && o.composed.parsed === MARKED, show(o))
}

section('§4 a custom option the catalogue does not recognise (MERCURY_CUSTOM_MODEL_OPTION) composes too')
{
  const o = compose('custom', {}, { MERCURY_CUSTOM_MODEL_OPTION: 'house-model-7' }, 'house-model-7')
  check('the picker composes inside the budget', o.state === 'answered', show(o))
  check('the custom row stands once and parses to itself', o.state === 'answered' && o.composed.probeRows === 1 && o.composed.parsed === 'house-model-7', show(o))
}

section('§5 the law in the source: the picker parses its own rows without the catalogue fold')
{
  const options = readFileSync(join(ROOT, 'src/utils/model/modelOptions.ts'), 'utf8')
  const folded = options.match(/\bparseUserSpecifiedModel\(/g) ?? []
  const raw = options.match(/\bparseUserSpecifiedModelRaw\(/g) ?? []
  check('modelOptions.ts calls no parser that reads the catalogue back (parseUserSpecifiedModel), only the raw one', folded.length === 0 && raw.length > 0, `folded ${folded.length} · raw ${raw.length}`)
  const fold = readFileSync(join(ROOT, 'src/utils/model/modelSpellingFold.ts'), 'utf8')
  check("the fold's own row target is the raw parser too", fold.includes('parseUserSpecifiedModelRaw(normalizeModelStringForAPI(value))') && !/\bparseUserSpecifiedModel\(/.test(fold))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)

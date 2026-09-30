#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'splash-grok-row-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'XAI_API_KEY']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const ROOT = join(import.meta.dir, '..', '..')
const CORE = join(ROOT, 'assets', 'splash', 'splash-core.mjs')
const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const coreSrc = readFileSync(CORE, 'utf8')
const splashSrc = readFileSync(SPLASH, 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const WORD = 'grok'
const { XAI_DISPLAY_PINS } = await import('../../src/services/providers/xai/xaiPins.ts')
const head = XAI_DISPLAY_PINS[0]

section('§0 the owner: the xAI pin table names the Grok rows the splash bakes')
check('the pin table carries at least one Grok row (the wire lane\'s pins; empty means the stub still stands)', head !== undefined, 'XAI_DISPLAY_PINS is empty')
check('every pin is a grok-* id with a display name', XAI_DISPLAY_PINS.every(pin => /^grok-/.test(pin.id) && pin.displayName.trim() !== ''), XAI_DISPLAY_PINS.map(pin => pin.id).join(','))
check('the pin ids are distinct', new Set(XAI_DISPLAY_PINS.map(pin => pin.id.toLowerCase())).size === XAI_DISPLAY_PINS.length)

section('§1 the baked table in source: the rows, their words and their place')
{
  const block = /^const MODEL_NAMES = \{\n([\s\S]*?)^\}$/m.exec(coreSrc)?.[1] ?? ''
  const rows = block.split('\n').map(line => line.trim()).filter(line => line !== '')
  check('the model-name block is baked into the core', block.length > 0)
  for (const pin of XAI_DISPLAY_PINS) {
    const id = pin.id.toLowerCase()
    check(`the table carries "${id}": "${pin.displayName}" once`, rows.filter(line => line.startsWith(`"${id}":`)).length === 1 && rows.includes(`"${id}": ${JSON.stringify(pin.displayName)},`), rows.find(line => line.startsWith(`"${id}":`)) ?? '(no row)')
  }
  const firstGrok = rows.findIndex(line => line.startsWith('"grok-'))
  const lastFirstParty = rows.reduce((at, line, index) => (line.startsWith('"claude-') ? index : at), -1)
  const firstAlias = rows.findIndex(line => line.startsWith('"sonnet":'))
  check('the Grok id rows sit after the first-party id rows and before the alias rows', firstGrok !== -1 && lastFirstParty !== -1 && firstAlias !== -1 && firstGrok > lastFirstParty && firstGrok < firstAlias, `${lastFirstParty} < ${firstGrok} < ${firstAlias}`)
  check(`the family word bakes to the newest row: "${WORD}": "${head?.displayName ?? '?'}"`, head !== undefined && rows.includes(`"${WORD}": ${JSON.stringify(head.displayName)},`), rows.find(line => line.startsWith(`"${WORD}":`)) ?? '(no word row)')
  check('the family word appears once in the table', rows.filter(line => line.startsWith(`"${WORD}":`)).length === 1)
  check('the Sonnet 5.5 row still stands (the first-party rows are untouched)', rows.includes('"claude-sonnet-5-5": "Sonnet 5.5",'))
  const generator = readFileSync(join(ROOT, 'scripts', 'splash', 'bake-menu.mjs'), 'utf8')
  const suite = readFileSync(join(ROOT, 'scripts', 'splash', 'run-all.sh'), 'utf8')
  check('the generator reads the xAI pin owner and bakes the family word from its first row, and the suite runs its drift gate', generator.includes("await import('../../src/services/providers/xai/xaiPins.ts')") && generator.includes('for (const pin of XAI_DISPLAY_PINS)') && generator.includes('names.grok = grokHead.displayName') && suite.includes('bake-menu.mjs" --check'))
}

section("§2 the core's exported table agrees with the owner")
{
  const { MODEL_NAMES } = (await import(CORE)) as { MODEL_NAMES: Record<string, string> }
  for (const pin of XAI_DISPLAY_PINS) {
    check(`the export names ${pin.id} "${pin.displayName}"`, MODEL_NAMES[pin.id.toLowerCase()] === pin.displayName, String(MODEL_NAMES[pin.id.toLowerCase()]))
  }
  check(`the export's "${WORD}" is the newest pin's name`, head !== undefined && MODEL_NAMES[WORD] === head.displayName, String(MODEL_NAMES[WORD]))
  check('the export keeps prototype names out (a settings value of "constructor" renders raw)', !Object.hasOwn(MODEL_NAMES, 'constructor'))
}

section("§3 the strip's own label law, run from the splash's source against the baked table")
{
  const fn = /function computeModelLabel\(\) \{[\s\S]*?\n\}/.exec(splashSrc)?.[0]
  check('computeModelLabel is in the splash source', fn !== undefined)
  const { MODEL_NAMES } = (await import(CORE)) as { MODEL_NAMES: Record<string, string> }
  const home = join(scratch, 'strip-home')
  mkdirSync(home, { recursive: true })
  const label = (model: string): string => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model }))
    const factory = new Function('readFileSync', 'join', 'CONFIG_HOME', 'MODEL_NAMES', `${fn}\nreturn computeModelLabel()`) as (a: typeof readFileSync, b: typeof join, c: string, d: Record<string, string>) => string
    return factory(readFileSync, join, home, MODEL_NAMES)
  }
  if (head !== undefined) {
    check(`a settings pin of ${head.id} paints "${head.displayName}"`, label(head.id) === head.displayName, label(head.id))
    check(`a settings pin of "${WORD}" paints what it boots: "${head.displayName}"`, label(WORD) === head.displayName, label(WORD))
    check('a settings pin with case folds to the row', label(head.id.toUpperCase()) === head.displayName, label(head.id.toUpperCase()))
  }
  check('a settings pin of claude-sonnet-5-5 still paints "Sonnet 5.5"', label('claude-sonnet-5-5') === 'Sonnet 5.5', label('claude-sonnet-5-5'))
  check('an unknown grok id still paints raw', label('grok-0.1-fixture') === 'grok-0.1-fixture', label('grok-0.1-fixture'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} splash Grok row check(s) failed`)
  process.exit(1)
}
console.log(' ALL SPLASH GROK ROW PROOFS PASS')

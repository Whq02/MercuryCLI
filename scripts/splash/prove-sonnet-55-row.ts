#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'splash-sonnet-55-row-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
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

const ID = 'claude-sonnet-5-5'
const PREVIOUS = 'claude-sonnet-5'
const NAME = 'Sonnet 5.5'

section('§1 the baked table in source: the row, its words and its place')
{
  const block = /^const MODEL_NAMES = \{\n([\s\S]*?)^\}$/m.exec(coreSrc)?.[1] ?? ''
  const rows = block.split('\n').map(line => line.trim()).filter(line => line !== '')
  const row = rows.findIndex(line => line.startsWith(`"${ID}":`))
  const previous = rows.findIndex(line => line.startsWith(`"${PREVIOUS}":`))
  check('the model-name block is baked into the core', block.length > 0)
  check(`the table carries "${ID}": "${NAME}"`, rows[row] === `"${ID}": "${NAME}",`, rows[row] ?? '(no row)')
  check(`the row sits right after "${PREVIOUS}" — the id table's order, newest generation last in its family`, row !== -1 && previous !== -1 && row === previous + 1, `${previous} → ${row}`)
  check('Sonnet 5 keeps its own row and words', rows[previous] === `"${PREVIOUS}": "Sonnet 5",`, rows[previous] ?? '(no row)')
  check(`the family word bakes to the newest row: "sonnet": "${NAME}"`, rows.includes(`"sonnet": "${NAME}",`), rows.find(line => line.startsWith('"sonnet":')) ?? '(no alias row)')
  check('the id appears once in the table', rows.filter(line => line.startsWith(`"${ID}":`)).length === 1)
  check('the bake marks stand around the block (the generator owns it)', coreSrc.includes('// MERCURY-MODEL-NAMES-START') && coreSrc.includes('// MERCURY-MODEL-NAMES-END'))
}

section("§2 the core's exported table agrees with the owners the bake reads")
{
  const { MODEL_NAMES } = (await import(CORE)) as { MODEL_NAMES: Record<string, string> }
  const { getMarketingNameForModel, parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  check(`the export names ${ID} "${NAME}"`, MODEL_NAMES[ID] === NAME, String(MODEL_NAMES[ID]))
  check('the export agrees with the marketing owner for the row', MODEL_NAMES[ID] === getMarketingNameForModel(ID), `${String(MODEL_NAMES[ID])} vs ${String(getMarketingNameForModel(ID))}`)
  check("the alias row is what a saved 'sonnet' boots", MODEL_NAMES.sonnet === getMarketingNameForModel(parseUserSpecifiedModel('sonnet')) && MODEL_NAMES.sonnet === NAME, `${String(MODEL_NAMES.sonnet)} vs ${String(getMarketingNameForModel(parseUserSpecifiedModel('sonnet')))}`)
  check('Sonnet 5 stays its own name in the export', MODEL_NAMES[PREVIOUS] === 'Sonnet 5', String(MODEL_NAMES[PREVIOUS]))
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
  check(`a settings pin of ${ID} paints "${NAME}"`, label(ID) === NAME, label(ID))
  check(`a settings pin of ${ID}[1m] paints "${NAME} (1M)"`, label(`${ID}[1m]`) === `${NAME} (1M)`, label(`${ID}[1m]`))
  check(`a settings pin of "sonnet" paints what it boots: "${NAME}"`, label('sonnet') === NAME, label('sonnet'))
  check('a settings pin with case folds to the row', label('Claude-Sonnet-5-5') === NAME, label('Claude-Sonnet-5-5'))
  check('a settings pin of claude-sonnet-5 still paints "Sonnet 5"', label(PREVIOUS) === 'Sonnet 5', label(PREVIOUS))
  check('an unknown id still paints raw', label('acme-turbo-9') === 'acme-turbo-9', label('acme-turbo-9'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} splash Sonnet 5.5 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL SPLASH SONNET 5.5 ROW PROOFS PASS')

#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'splash-key-lane-rows-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZAI_API_KEY']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const ROOT = join(import.meta.dir, '..', '..')
const CORE = join(ROOT, 'assets', 'splash', 'splash-core.mjs')
const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const GENERATOR = process.env.SPLASH_BAKE_GENERATOR ?? join(ROOT, 'scripts', 'splash', 'bake-menu.mjs')
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

interface Pin {
  id: string
  displayName: string
}
interface Family {
  word: string
  label: string
  shape: RegExp
  owner: string
  pins: Pin[]
  head: Pin | undefined
}

const { DEEPSEEK_DISPLAY_PINS, DEEPSEEK_RETIRED_ALIASES, deepseekDisplayName } = await import('../../src/services/providers/deepseek/deepseekPins.ts')
const { KIMI_DISPLAY_PINS, KIMI_PLAN_PINS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { GLM_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/zai.ts')
const glmPins: Pin[] = GLM_STATIC_CATALOGUE.map(entry => ({ id: entry.id, displayName: entry.displayLabel }))
const deepseekRetired: Pin[] = [...DEEPSEEK_RETIRED_ALIASES.keys()].map(id => ({ id, displayName: deepseekDisplayName(id) }))
const FAMILIES: Family[] = [
  { word: 'deepseek', label: 'DeepSeek', shape: /^deepseek-/, owner: 'src/services/providers/deepseek/deepseekPins.ts', pins: [...DEEPSEEK_DISPLAY_PINS, ...deepseekRetired], head: DEEPSEEK_DISPLAY_PINS[0] },
  { word: 'kimi', label: 'Kimi', shape: /^(?:kimi-|k3(?:-|$))/, owner: 'src/services/providers/moonshot/kimiPins.ts', pins: [...KIMI_DISPLAY_PINS, ...KIMI_PLAN_PINS], head: KIMI_DISPLAY_PINS[0] },
  { word: 'glm', label: 'GLM', shape: /^glm-/, owner: 'src/utils/router/providers/zai.ts', pins: glmPins, head: glmPins[0] },
]
const rowOf = (pin: Pin): string => `${JSON.stringify(pin.id.toLowerCase())}: ${JSON.stringify(pin.displayName)},`
const rowsOf = (text: string): string[] => (/^const MODEL_NAMES = \{\n([\s\S]*?)^\}$/m.exec(text)?.[1] ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
const lastIndex = (rows: string[], test: (line: string) => boolean): number => rows.reduce((at, line, index) => (test(line) ? index : at), -1)

section('§0 the owners: each family\'s pin table names the rows the splash bakes')
for (const family of FAMILIES) {
  check(`the ${family.label} table carries at least one row with a head`, family.pins.length > 0 && family.head !== undefined, family.owner)
  check(`every ${family.label} row is a ${family.word} id with a display name`, family.pins.every(pin => family.shape.test(pin.id.toLowerCase()) && pin.displayName.trim() !== ''), family.pins.map(pin => pin.id).join(','))
  check(`the ${family.label} ids are distinct`, new Set(family.pins.map(pin => pin.id.toLowerCase())).size === family.pins.length)
}
check('the retired DeepSeek spelling names its successor\'s words', deepseekRetired.length > 0 && deepseekRetired.every(pin => DEEPSEEK_DISPLAY_PINS.some(current => current.displayName === pin.displayName)), deepseekRetired.map(pin => `${pin.id}=${pin.displayName}`).join(','))
check('the Kimi plan rows ride the plan\'s own ids', KIMI_PLAN_PINS.length > 0 && KIMI_PLAN_PINS.every(pin => /^k3/.test(pin.id)), KIMI_PLAN_PINS.map(pin => pin.id).join(','))

section('§1 the bake against a scratch copy of the core: the rows, their words and their place')
const tree = join(scratch, 'tree')
for (const dir of ['scripts/splash', 'scripts/lib', 'scripts/gate', 'assets/splash']) mkdirSync(join(tree, dir), { recursive: true })
copyFileSync(GENERATOR, join(tree, 'scripts', 'splash', 'bake-menu.mjs'))
copyFileSync(join(ROOT, 'scripts', 'lib', 'generated-assets-map.mjs'), join(tree, 'scripts', 'lib', 'generated-assets-map.mjs'))
copyFileSync(CORE, join(tree, 'assets', 'splash', 'splash-core.mjs'))
symlinkSync(join(ROOT, 'src'), join(tree, 'src'))
symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'))
let bakeOut = ''
let bakeRc = 0
try {
  bakeOut = execFileSync(process.execPath, [join(tree, 'scripts', 'splash', 'bake-menu.mjs')], { cwd: tree, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  bakeRc = (error as { status?: number }).status ?? 1
  bakeOut = String((error as { stdout?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '')
}
check(`the generator bakes the scratch copy (${GENERATOR === join(ROOT, 'scripts', 'splash', 'bake-menu.mjs') ? 'the tree\'s generator' : GENERATOR})`, bakeRc === 0, bakeOut.trim().split('\n').slice(-3).join(' | '))
{
  const baked = readFileSync(join(tree, 'assets', 'splash', 'splash-core.mjs'), 'utf8')
  const rows = rowsOf(baked)
  check('the model-name block is baked into the scratch core', rows.length > 0)
  for (const family of FAMILIES) {
    for (const pin of family.pins) {
      const id = pin.id.toLowerCase()
      check(`the table carries "${id}": "${pin.displayName}" once`, rows.filter(line => line.startsWith(`"${id}":`)).length === 1 && rows.includes(rowOf(pin)), rows.find(line => line.startsWith(`"${id}":`)) ?? '(no row)')
    }
    const at = family.pins.map(pin => rows.indexOf(rowOf(pin)))
    check(`the ${family.label} rows sit together in the owner's order`, at.every((index, i) => index !== -1 && (i === 0 || index === at[i - 1]! + 1)), at.join(','))
    check(`the family word bakes to the newest row: "${family.word}": "${family.head?.displayName ?? '?'}"`, family.head !== undefined && rows.includes(`"${family.word}": ${JSON.stringify(family.head.displayName)},`), rows.find(line => line.startsWith(`"${family.word}":`)) ?? '(no word row)')
    check(`the word "${family.word}" appears once in the table`, rows.filter(line => line.startsWith(`"${family.word}":`)).length === 1)
  }
  const firstFamilyId = rows.findIndex(line => line.startsWith('"deepseek-'))
  const lastFirstParty = lastIndex(rows, line => line.startsWith('"claude-'))
  const lastGrokId = lastIndex(rows, line => line.startsWith('"grok-'))
  const firstAlias = rows.findIndex(line => line.startsWith('"sonnet":'))
  check('the family id rows sit after the first-party and Grok id rows and before the alias rows', firstFamilyId !== -1 && lastFirstParty !== -1 && lastGrokId !== -1 && firstAlias !== -1 && lastFirstParty < lastGrokId && lastGrokId < firstFamilyId && firstFamilyId < firstAlias, `${lastFirstParty} < ${lastGrokId} < ${firstFamilyId} < ${firstAlias}`)
  const grokWord = rows.findIndex(line => line.startsWith('"grok":'))
  check('the three family words sit after the grok word, in the owners\' order', grokWord !== -1 && FAMILIES.map(family => rows.findIndex(line => line.startsWith(`"${family.word}":`))).every((index, i, all) => index > (i === 0 ? grokWord : all[i - 1]!)))
  check('the Sonnet 5.5 row still stands (the first-party rows are untouched)', rows.includes('"claude-sonnet-5-5": "Sonnet 5.5",'))
  check('the Grok 4.7 row and the grok word still stand (the xAI rows are untouched)', rows.includes('"grok-4.7": "Grok 4.7",') && rows.includes('"grok": "Grok 4.7",'))
  check('the committed core carries the block the generator writes', rowsOf(coreSrc).join('\n') === rows.join('\n'))
  const map = readFileSync(join(tree, 'scripts', 'gate', 'generated-assets.tsv'), 'utf8')
  const mapRow = map.split('\n').find(line => line.includes('\tbun scripts/splash/bake-menu.mjs\t')) ?? ''
  check('the generator registers the three owners as sources of the bake', FAMILIES.every(family => mapRow.split('\t')[3]?.split(' ').includes(family.owner)), mapRow)
}

section("§2 the core's exported table agrees with the owners")
{
  const { MODEL_NAMES } = (await import(CORE)) as { MODEL_NAMES: Record<string, string> }
  for (const family of FAMILIES) {
    for (const pin of family.pins) {
      check(`the export names ${pin.id} "${pin.displayName}"`, MODEL_NAMES[pin.id.toLowerCase()] === pin.displayName, String(MODEL_NAMES[pin.id.toLowerCase()]))
    }
    check(`the export's "${family.word}" is the newest ${family.label} row's name`, family.head !== undefined && MODEL_NAMES[family.word] === family.head.displayName, String(MODEL_NAMES[family.word]))
  }
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
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { model } }))
    const factory = new Function('readFileSync', 'join', 'CONFIG_HOME', 'MODEL_NAMES', `${fn}\nreturn computeModelLabel()`) as (a: typeof readFileSync, b: typeof join, c: string, d: Record<string, string>) => string
    return factory(readFileSync, join, home, MODEL_NAMES)
  }
  for (const family of FAMILIES) {
    const head = family.head
    if (head === undefined) continue
    check(`a settings pin of ${head.id} paints "${head.displayName}"`, label(head.id) === head.displayName, label(head.id))
    check(`a settings pin of "${family.word}" paints the newest row: "${head.displayName}"`, label(family.word) === head.displayName, label(family.word))
    check(`a settings pin of ${head.id.toUpperCase()} folds to the row`, label(head.id.toUpperCase()) === head.displayName, label(head.id.toUpperCase()))
    check(`an unknown ${family.word} id still paints raw`, label(`${family.word}-0.1-stub`) === `${family.word}-0.1-stub`, label(`${family.word}-0.1-stub`))
  }
  for (const pin of deepseekRetired) check(`a settings pin of the retired ${pin.id} paints its successor's words: "${pin.displayName}"`, label(pin.id) === pin.displayName, label(pin.id))
  for (const pin of KIMI_PLAN_PINS) check(`a settings pin of the plan's ${pin.id} paints "${pin.displayName}"`, label(pin.id) === pin.displayName, label(pin.id))
  check('a settings pin of claude-sonnet-5-5 still paints "Sonnet 5.5"', label('claude-sonnet-5-5') === 'Sonnet 5.5', label('claude-sonnet-5-5'))
  check('a settings pin of grok-4.7 still paints "Grok 4.7"', label('grok-4.7') === 'Grok 4.7', label('grok-4.7'))
}

section('§4 the wiring: the generator reads the owners and the suite runs this proof')
{
  const generator = readFileSync(GENERATOR, 'utf8')
  const suite = readFileSync(join(ROOT, 'scripts', 'splash', 'run-all.sh'), 'utf8')
  for (const family of FAMILIES) check(`the generator reads ${family.owner}`, generator.includes(`await import('../../${family.owner}')`))
  check('the generator bakes the retired DeepSeek spellings and the Kimi plan rows', generator.includes('DEEPSEEK_RETIRED_ALIASES.keys()') && generator.includes('KIMI_PLAN_PINS'))
  check('the suite runs this proof beside the Grok row proof', suite.includes('prove-grok-row.ts') && suite.includes('prove-deepseek-kimi-glm-rows.ts'))
  const trackedMap = readFileSync(join(ROOT, 'scripts', 'gate', 'generated-assets.tsv'), 'utf8')
  const trackedRow = trackedMap.split('\n').find(line => line.includes('\tbun scripts/splash/bake-menu.mjs\t')) ?? ''
  check('the tracked generated-assets map names the three owners as sources of the bake', FAMILIES.every(family => trackedRow.split('\t')[3]?.split(' ').includes(family.owner)), trackedRow)
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} splash DeepSeek/Kimi/GLM row check(s) failed`)
  process.exit(1)
}
console.log(' ALL SPLASH DEEPSEEK/KIMI/GLM ROW PROOFS PASS')

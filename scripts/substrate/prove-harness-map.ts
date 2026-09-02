#!/usr/bin/env bun

import '../lib/hermetic.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const saved = {
  map: process.env.MERCURY_HARNESS_MAP,
  tabula: process.env.MERCURY_TABULA,
  workflows: process.env.MERCURY_WORKFLOWS,
  godot: process.env.MERCURY_GODOT,
  mneme: process.env.MERCURY_MNEME,
  themis: process.env.MERCURY_THEMIS,
}
delete process.env.MERCURY_HARNESS_MAP
delete process.env.MERCURY_TABULA
delete process.env.MERCURY_WORKFLOWS
delete process.env.MERCURY_GODOT
delete process.env.MERCURY_MNEME
delete process.env.MERCURY_THEMIS

const { getHarnessMapSection, harnessMapEnabled, resetHarnessMapForTest } =
  await import('../../src/utils/cockpit/harnessMap.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('prove-harness-map — surface-map self-knowledge (#171)')

resetHarnessMapForTest()
const on = getHarnessMapSection()
check('default-ON: section present', on !== null)
check('header present', on !== null && on.startsWith('# Mercury harness map'))
check('names the native identity', on !== null && on.includes('natively inside Mercury'))
check('routes discovery to /capabilities', on !== null && on.includes('/capabilities'))
check('routes provider-API work to the bundled provider-apis skill (task #9)', on !== null && on.includes('provider-apis'))
check('TABULA advertised when its gate is ON', on !== null && on.includes('/note'))
check(
  'no exhortation drift: single # header only',
  on !== null && on.split('\n').filter(l => l.startsWith('# ')).length === 1,
)
check('opt-in Godot NOT advertised when off', on !== null && !on.includes('Godot'))
check('opt-in MNEME NOT advertised when off', on !== null && !on.includes('MNEME'))
check('default-on THEMIS advertised at enforce in the default map', on !== null && on.includes('THEMIS control plane is ACTIVE (enforce)'))

resetHarnessMapForTest()
process.env.MERCURY_THEMIS = 'off'
const themisOff = getHarnessMapSection()
check('explicit THEMIS off ⇒ not advertised', themisOff !== null && !themisOff.includes('THEMIS'))
delete process.env.MERCURY_THEMIS

resetHarnessMapForTest()
process.env.MERCURY_GODOT = '1'
process.env.MERCURY_MNEME = '1'
process.env.MERCURY_THEMIS = 'warn'
const armedMap = getHarnessMapSection()
check('Godot lane advertised when armed', armedMap !== null && armedMap.includes('Godot lanes are ARMED'))
check('MNEME advertised when armed', armedMap !== null && armedMap.includes('MNEME'))
check('THEMIS advertised with its level', armedMap !== null && armedMap.includes('THEMIS control plane is ACTIVE (warn)'))
delete process.env.MERCURY_GODOT
delete process.env.MERCURY_MNEME
delete process.env.MERCURY_THEMIS
resetHarnessMapForTest()
const reprimed = getHarnessMapSection()
check('re-primed default map matches first compute', reprimed === on)

process.env.MERCURY_HARNESS_MAP = '0'
const memoized = getHarnessMapSection()
check('memoized per process (flag flip after compute is inert)', memoized === on)
delete process.env.MERCURY_HARNESS_MAP

resetHarnessMapForTest()
process.env.MERCURY_HARNESS_MAP = '0'
check('enabled() honest under =0', harnessMapEnabled() === false)
check('=0 ⇒ null section', getHarnessMapSection() === null)
delete process.env.MERCURY_HARNESS_MAP

resetHarnessMapForTest()
process.env.MERCURY_TABULA = '0'
const partial = getHarnessMapSection()
check('map still present with some gates off', partial !== null)
check('TABULA line dropped when MERCURY_TABULA=0', partial !== null && !partial.includes('/note') && !partial.includes('/tabula'))
check('missing-surface disclaimer present', partial !== null && partial.includes('gated off in this boot'))
delete process.env.MERCURY_TABULA

{
  resetHarnessMapForTest()
  delete process.env.MERCURY_LSP
  const uncovered = getHarnessMapSection()
  check(
    'catalog-on + NOT connected ⇒ the LSP tool is NOT advertised',
    uncovered !== null && !uncovered.includes('the LSP tool'),
  )
  const mapSrc = readFileSync(join(import.meta.dir, '../../src/utils/cockpit/harnessMap.ts'), 'utf8')
  check(
    'the map line keys on the SAME predicate the roster uses (isLspToolMounted)',
    /lspConnectedSafe[\s\S]{0,600}isLspToolMounted/.test(mapSrc) &&
      /isLspToolCatalogEnabled\(\) && lspConnectedSafe\(\)/.test(mapSrc),
  )
  const lspToolSrc = readFileSync(join(import.meta.dir, '../../src/tools/LSPTool/LSPTool.ts'), 'utf8')
  check(
    "…and that predicate IS the roster's gate (LSPTool.isEnabled → isLspToolMounted)",
    /isEnabled\(\): boolean \{\s*return isLspToolMounted\(\)/.test(lspToolSrc),
  )
  resetHarnessMapForTest()
}

const promptsSrc = readFileSync(
  join(import.meta.dir, '../../src/constants/prompts.ts'),
  'utf8',
)
check(
  "prompts.ts wires systemPromptSection('harness_map')",
  promptsSrc.includes("systemPromptSection('harness_map'"),
)

{
  const { getHarnessMapDelta, getHarnessMapSection, resetHarnessMapForTest } = await import(
    '../../src/utils/cockpit/harnessMap.ts'
  )
  const landed = (d: { added: string[]; removed: string[] }) => ({
    type: 'attachment',
    attachment: { type: 'harness_map_delta', added: d.added, removed: d.removed },
  })
  resetHarnessMapForTest()
  delete process.env.MERCURY_HARNESS_MAP
  delete process.env.MERCURY_MNEME
  getHarnessMapSection()
  check('no delta right after the prompt block (baseline)', getHarnessMapDelta([]) === null)
  process.env.MERCURY_MNEME = '1'
  const d1 = getHarnessMapDelta([])
  check('an armed opt-in emits a delta', d1 !== null && d1.added.some(l => l.includes('MNEME')))
  check('the delta removed-side is empty on an arm', d1 !== null && d1.removed.length === 0)
  const d1again = getHarnessMapDelta([])
  check('an unlanded delta re-announces next turn (abort-proof)',
    d1again !== null && d1again.added.some(l => l.includes('MNEME')))
  const history = [landed(d1!)]
  check('announce-once: silent once the attachment LANDED', getHarnessMapDelta(history) === null)
  delete process.env.MERCURY_MNEME
  const d2 = getHarnessMapDelta(history)
  check('a disarm emits the removed side', d2 !== null && d2.removed.some(l => l.includes('MNEME')))
  const history2 = [...history, landed(d2!)]
  check('announce-once holds after the disarm too', getHarnessMapDelta(history2) === null)
  process.env.MERCURY_HARNESS_MAP = '0'
  process.env.MERCURY_MNEME = '1'
  check('MERCURY_HARNESS_MAP=0 silences the delta', getHarnessMapDelta([]) === null)
  delete process.env.MERCURY_MNEME
  delete process.env.MERCURY_HARNESS_MAP
  resetHarnessMapForTest()
}

{
  const orch = readFileSync(join(import.meta.dir, '../../src/utils/attachments/orchestrator.ts'), 'utf8')
  check('orchestrator wires getHarnessMapDelta', orch.includes('getHarnessMapDelta'))
  const text = readFileSync(join(import.meta.dir, '../../src/utils/messages/attachmentText.ts'), 'utf8')
  check('attachmentText renders harness_map_delta', text.includes("case 'harness_map_delta'"))
  const nullr = readFileSync(join(import.meta.dir, '../../src/components/messages/nullRenderingAttachments.ts'), 'utf8')
  check('harness_map_delta is null-rendering (no transcript chrome)', nullr.includes("'harness_map_delta'"))
}

const registrySrc = readFileSync(
  join(import.meta.dir, '../../src/substrate/flagRegistry.ts'),
  'utf8',
)
const rowCount = registrySrc.split("env: 'MERCURY_HARNESS_MAP'").length - 1
check('flagRegistry row present exactly once', rowCount === 1, `count=${rowCount}`)

for (const [k, v] of Object.entries({
  MERCURY_HARNESS_MAP: saved.map,
  MERCURY_TABULA: saved.tabula,
  MERCURY_WORKFLOWS: saved.workflows,
  MERCURY_GODOT: saved.godot,
  MERCURY_MNEME: saved.mneme,
  MERCURY_THEMIS: saved.themis,
})) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

{
  const { effectiveCatalogue } = await import('../../src/commands/effectiveCatalogue.js')
  const registered = new Set(
    effectiveCatalogue().flatMap(surface => [surface.name, ...surface.aliases]),
  )
  const DOOR_RE = /(^|[\s(`,])\/([a-z][a-z0-9-]*)(?![a-z0-9-/])/g
  const LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
  const REPO = join(import.meta.dir, '..', '..')
  for (const rel of ['src/utils/cockpit/harnessMap.ts', 'src/utils/messages/systemMessages.ts']) {
    const text = readFileSync(join(REPO, rel), 'utf8')
    const dead: string[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(LITERAL_RE)) {
      const literal = m[2]!
      if (!literal.includes(' ')) continue
      for (const dm of literal.matchAll(DOOR_RE)) {
        const door = dm[2]!
        seen.add(door)
        if (!registered.has(door)) dead.push(`/${door} in ${JSON.stringify(literal.slice(0, 70))}`)
      }
    }
    check(
      `${rel}: every prose slash-door is a registered command or alias (${[...seen].sort().join(', ') || 'none named'})`,
      dead.length === 0,
      dead.join(' · '),
    )
  }
}

console.log(failures === 0 ? '✅ prove-harness-map: ALL PASS' : `❌ prove-harness-map: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

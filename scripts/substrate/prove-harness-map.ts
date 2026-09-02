#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-harness-map.ts
//  PROOF: surface-map self-knowledge (MERCURY_HARNESS_MAP).
//
//  The contract under proof: the system prompt carries a "Mercury harness map"
//  block naming the NATIVE surfaces (TABULA notes, workflows, SATURN,
//  session fabric, IDE-hands, crews, /capabilities//doctor discovery), and it
//  obeys the house gate rules:
//   - default-ON; MERCURY_HARNESS_MAP=0 ⇒ null ⇒ byte-identical absence
//   - PER-LINE HONESTY: a surface whose own gate is OFF at boot is NOT
//     advertised (the stale-claim class — the map must never name a dead door)
//   - memoized per process (prompt-cache byte-stability)
//   - structurally wired as the 'harness_map' dynamic section in prompts.ts
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-harness-map.ts
// ============================================================================

// Hermetic preamble FIRST (ambient-state law): unpinned, a proof's writes
// land in the operator's REAL home (the leak class). The shared
// sweep-then-pin owns the shape.
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

// ---- 1. default ON: the block exists and names the discovery surfaces ----
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
// THEMIS is default-on: the DEFAULT map advertises it armed at
// enforce (#182 — an armed lane the model does not know about is unreachable).
check('default-on THEMIS advertised at enforce in the default map', on !== null && on.includes('THEMIS control plane is ACTIVE (enforce)'))

// ---- 1a. explicit opt-out removes the line ----
resetHarnessMapForTest()
process.env.MERCURY_THEMIS = 'off'
const themisOff = getHarnessMapSection()
check('explicit THEMIS off ⇒ not advertised', themisOff !== null && !themisOff.includes('THEMIS'))
delete process.env.MERCURY_THEMIS

// ---- 1b. armed opt-ins announce themselves (#182) ----
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
// Re-prime the memo with the DEFAULT map so section 2's memoization check
// compares against the same computed value.
const reprimed = getHarnessMapSection()
check('re-primed default map matches first compute', reprimed === on)

// ---- 2. memoization: env flips after first compute do NOT change output ----
process.env.MERCURY_HARNESS_MAP = '0'
const memoized = getHarnessMapSection()
check('memoized per process (flag flip after compute is inert)', memoized === on)
delete process.env.MERCURY_HARNESS_MAP

// ---- 3. kill: =0 ⇒ null (byte-identical absence) ----
resetHarnessMapForTest()
process.env.MERCURY_HARNESS_MAP = '0'
check('enabled() honest under =0', harnessMapEnabled() === false)
check('=0 ⇒ null section', getHarnessMapSection() === null)
delete process.env.MERCURY_HARNESS_MAP

// ---- 4. PER-LINE HONESTY: an OFF capability is not advertised ----
resetHarnessMapForTest()
process.env.MERCURY_TABULA = '0'
const partial = getHarnessMapSection()
check('map still present with some gates off', partial !== null)
check('TABULA line dropped when MERCURY_TABULA=0', partial !== null && !partial.includes('/note') && !partial.includes('/tabula'))
check('missing-surface disclaimer present', partial !== null && partial.includes('gated off in this boot'))
delete process.env.MERCURY_TABULA

// ---- 4b. the LSP half of the code-intelligence line keys on CONNECTION ----
// (small-fix bundle item 5, AX4's find): the roster gates LSPTool on
// isLspConnected() (LSPTool.isEnabled), while this line rendered on the
// CATALOG gate alone — advertised-while-absent in every uncovered project.
// In this process the catalog gate is ON (MERCURY_LSP default-on) and no
// server ever connected — exactly the uncovered-project shape.
{
  resetHarnessMapForTest()
  delete process.env.MERCURY_LSP
  const uncovered = getHarnessMapSection()
  check(
    'catalog-on + NOT connected ⇒ the LSP tool is NOT advertised',
    uncovered !== null && !uncovered.includes('the LSP tool'),
  )
  // The predicate is the MOUNT predicate (isLspToolMounted — a configured
  // server in error keeps the tool and this line, so serverStatus can say
  // what failed; release-hardening audit rank 56), never the health one.
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

// ---- 5. structural wiring: prompts.ts registers the dynamic section ----
const promptsSrc = readFileSync(
  join(import.meta.dir, '../../src/constants/prompts.ts'),
  'utf8',
)
check(
  "prompts.ts wires systemPromptSection('harness_map')",
  promptsSrc.includes("systemPromptSection('harness_map'"),
)

// ---- 5b. the MID-SESSION delta (#182 leg b): a gate flip announces ONCE.
//      The announce-once cursor is the THREAD'S MESSAGE HISTORY (product-study
//      r2: the old module-global cursor advanced on RETURN, so any consumer —
//      a subagent's attachment pass, an aborted turn — could swallow the main
//      session's one announcement forever). A delta repeats until its
//      attachment actually LANDS in `messages`; a landed one never repeats. ----
{
  const { getHarnessMapDelta, getHarnessMapSection, resetHarnessMapForTest } = await import(
    '../../src/utils/cockpit/harnessMap.ts'
  )
  // A landed harness_map_delta attachment row, as the orchestrator appends it.
  const landed = (d: { added: string[]; removed: string[] }) => ({
    type: 'attachment',
    attachment: { type: 'harness_map_delta', added: d.added, removed: d.removed },
  })
  resetHarnessMapForTest()
  delete process.env.MERCURY_HARNESS_MAP
  delete process.env.MERCURY_MNEME
  getHarnessMapSection() // the prompt block sets the delta baseline
  check('no delta right after the prompt block (baseline)', getHarnessMapDelta([]) === null)
  process.env.MERCURY_MNEME = '1' // the mid-session arm
  const d1 = getHarnessMapDelta([])
  check('an armed opt-in emits a delta', d1 !== null && d1.added.some(l => l.includes('MNEME')))
  check('the delta removed-side is empty on an arm', d1 !== null && d1.removed.length === 0)
  // ABORT-PROOF: a collected-but-never-landed delta re-announces (the old
  // cursor semantics lost it forever here).
  const d1again = getHarnessMapDelta([])
  check('an unlanded delta re-announces next turn (abort-proof)',
    d1again !== null && d1again.added.some(l => l.includes('MNEME')))
  // SECOND CONSUMER: another consumer's poll (same empty history) cannot
  // swallow the announcement — the main thread still sees it above; only a
  // LANDED attachment silences it.
  const history = [landed(d1!)]
  check('announce-once: silent once the attachment LANDED', getHarnessMapDelta(history) === null)
  delete process.env.MERCURY_MNEME // the mid-session disarm
  const d2 = getHarnessMapDelta(history)
  check('a disarm emits the removed side', d2 !== null && d2.removed.some(l => l.includes('MNEME')))
  const history2 = [...history, landed(d2!)]
  check('announce-once holds after the disarm too', getHarnessMapDelta(history2) === null)
  // Kill-switch honesty: the delta respects MERCURY_HARNESS_MAP=0.
  process.env.MERCURY_HARNESS_MAP = '0'
  process.env.MERCURY_MNEME = '1'
  check('MERCURY_HARNESS_MAP=0 silences the delta', getHarnessMapDelta([]) === null)
  delete process.env.MERCURY_MNEME
  delete process.env.MERCURY_HARNESS_MAP
  resetHarnessMapForTest()
}

// ---- 5c. the attachment layer wiring is REAL (source lock) ----
{
  const orch = readFileSync(join(import.meta.dir, '../../src/utils/attachments/orchestrator.ts'), 'utf8')
  check('orchestrator wires getHarnessMapDelta', orch.includes('getHarnessMapDelta'))
  const text = readFileSync(join(import.meta.dir, '../../src/utils/messages/attachmentText.ts'), 'utf8')
  check('attachmentText renders harness_map_delta', text.includes("case 'harness_map_delta'"))
  const nullr = readFileSync(join(import.meta.dir, '../../src/components/messages/nullRenderingAttachments.ts'), 'utf8')
  check('harness_map_delta is null-rendering (no transcript chrome)', nullr.includes("'harness_map_delta'"))
}

// ---- 6. registry: the flag row exists exactly once ----
const registrySrc = readFileSync(
  join(import.meta.dir, '../../src/substrate/flagRegistry.ts'),
  'utf8',
)
const rowCount = registrySrc.split("env: 'MERCURY_HARNESS_MAP'").length - 1
check('flagRegistry row present exactly once', rowCount === 1, `count=${rowCount}`)

// ---- restore ----
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

// ---- the dead-door fence over the DOCTRINE surfaces ----------
// The header's law made token-level: a live map line naming a door no
// catalogue registers misleads every session (/loop and /schedule did until
// the SATURN line re-cut to the CronCreate tool family), and a system
// message is the same doctrine in the transcript. Sweep the PROSE literals
// of both source files; every slash-door token must be a registered command
// NAME or ALIAS. The guard is §9's twin (prove-auth-flow-matrix): backtick/
// comma-glued doors are caught, URL/wire paths are structurally out, and
// the (?![a-z0-9-/]) lookahead kills the backtracking escape.
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
      if (!literal.includes(' ')) continue // prose only — bare wire/path literals are not doors
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

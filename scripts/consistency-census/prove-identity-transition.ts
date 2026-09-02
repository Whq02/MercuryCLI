#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-identity-transition.ts — W1 (UN-05/06/07/10):
//  transition-aware runtime identity at the composition seam.
//
//  §A the model-visible env line follows the COMPOSED model (fresh state)
//  §B a live switch recomposes the keyed sections — the line follows the
//     APPLIED model with no /clear (the UN-05 regression pin)
//  §C stable turns are byte-stable AND recompute-free: the cache entry
//     OBJECT survives identical recomposition (setSystemPromptSectionCacheEntry
//     stores a fresh object on every write, so reference identity IS the
//     zero-recompute observable — prompt-cache discipline, L4)
//  §D same-model no-op composition changes nothing (entry reference held)
//  §E a switch changes EXACTLY the dependent sections: diffing the resolved
//     section arrays across a switch shows env_info_simple moved and every
//     other dynamic section byte-identical (frc is keyed too — its compute
//     is fork-stubbed null in this build, so its VALUE cannot move, but its
//     key follows the model: asserted directly on the cache entry)
//  §F /clear//compact recomputes: after clearSystemPromptSections a fresh
//     entry object appears with the same key discipline
//
//  Drives the REAL owners end-to-end: getSystemPrompt → systemPromptSection
//  machinery → bootstrap cache latches. No mocks.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unison-w1-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'unison-w1-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'unison-w1-proj-'))
bootstrap.setOriginalCwd(projDir)
process.chdir(projDir)

const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import(
  '../../src/constants/systemPromptSections.ts'
)

const MODEL_A = 'claude-opus-5'
const MODEL_B = 'claude-sonnet-5'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
// The engine-identity line (mercuryEngineIdentityLine): the id LEADS inside
// backticks — the one sentence shape every seat and prover reads back.
const lineOf = (blocks: string[]): string =>
  blocks.join('\n\n').match(/Mercury is what you are; the model you run through Mercury is[^\n]*/)?.[0] ?? '(no identity line)'
const cache = bootstrap.getSystemPromptSectionCache()

// §A — fresh composition binds the composed model
const promptA = await getSystemPrompt([], MODEL_A)
check('§A env line names the composed model', lineOf(promptA).includes(MODEL_A))
const entryA = cache.get('env_info_simple')
check('§A env_info_simple entry keyed on the model', entryA?.key?.includes(MODEL_A) === true)

// §B — live switch, no clear: the keyed section recomputes exactly once
const promptB = await getSystemPrompt([], MODEL_B)
const lineB = lineOf(promptB)
check('§B post-switch line follows the APPLIED model (UN-05)', lineB.includes(MODEL_B) && !lineB.includes(MODEL_A), lineB)
const entryB = cache.get('env_info_simple')
check('§B entry rekeyed to the applied model', entryB?.key?.includes(MODEL_B) === true)
check('§B frc entry keyed on the applied model too', cache.get('frc')?.key === MODEL_B)

// §C — stable turn: byte-stable AND recompute-free (entry object identity)
const promptB2 = await getSystemPrompt([], MODEL_B)
check('§C stable recomposition is byte-identical', JSON.stringify(promptB2) === JSON.stringify(promptB))
check('§C zero recompute on a stable turn (entry object held)', cache.get('env_info_simple') === entryB)

// §D — same-model no-op: nothing moves
await getSystemPrompt([], MODEL_B)
check('§D no-op composition holds every keyed entry', cache.get('env_info_simple') === entryB && cache.get('frc')?.key === MODEL_B)

// §E — a switch changes EXACTLY the dependent sections. The prompt arrays
// differ only where a keyed section's value moved: diff count == 1
// (env_info_simple; frc is null-valued in this build so it cannot move).
const promptA2 = await getSystemPrompt([], MODEL_A)
const changed: number[] = []
for (let i = 0; i < Math.max(promptA2.length, promptB2.length); i++) {
  if (promptA2[i] !== promptB2[i]) changed.push(i)
}
check('§E switch moves exactly one resolved block', changed.length === 1, `changed blocks: ${changed.length}`)
check('§E the moved block is the identity line', changed.length === 1 && lineOf([promptA2[changed[0]!] ?? '']).includes(MODEL_A))

// §F — clear recomputes with the same key discipline
const entryPreClear = cache.get('env_info_simple')
clearSystemPromptSections()
const promptA3 = await getSystemPrompt([], MODEL_A)
check('§F cleared recompose mints a fresh entry', cache.get('env_info_simple') !== entryPreClear && lineOf(promptA3).includes(MODEL_A))

// ── §G — the ONE settlement owner (UN-06/07): pure matrix ──────────────────
const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/utils/model/modelTransition.ts'
)
const base = {
  mainLoopModel: 'claude-opus-5' as string | null,
  mainLoopModelForSession: null as string | null,
  pendingModelSwitch: null as { setting: string | null } | null,
}

// §G1 idle apply
const g1 = settleModelSelection(base, MODEL_B, { turnActive: false })
check(
  '§G1 idle apply patches model + mints an applied/idle receipt',
  g1.kind === 'applied' &&
    g1.patch?.mainLoopModel === MODEL_B &&
    g1.receipt?.resolution === 'applied' &&
    g1.receipt?.boundary === 'idle' &&
    g1.receipt?.previous === 'claude-opus-5',
)
check('§G1 same-provider switch is not cross-provider', g1.kind === 'applied' && g1.receipt.crossProvider === false)

// §G2 mid-turn pick queues without a receipt
const g2 = settleModelSelection(base, MODEL_B, { turnActive: true })
check(
  '§G2 mid-turn pick parks in the pending slot, no receipt yet',
  g2.kind === 'queued' && g2.patch?.pendingModelSwitch?.setting === MODEL_B && g2.receipt === null,
)

// §G3 re-choosing the current model cancels a live pending (the SAME-MODEL
// law both surfaces share — a /model that keeps the pending alive is the guarded class)
const g3 = settleModelSelection(
  { ...base, pendingModelSwitch: { setting: MODEL_B } },
  'claude-opus-5',
  { turnActive: true },
)
check(
  '§G3 same-model pick cancels the queued switch with a receipt',
  g3.kind === 'cancelled-pending' &&
    g3.patch?.pendingModelSwitch === null &&
    g3.receipt?.resolution === 'cancelled-pending' &&
    g3.receipt?.requested === MODEL_B &&
    g3.receipt?.applied === 'claude-opus-5',
)

// §G4 plain no-op: nothing to write, nothing to record
const g4 = settleModelSelection(base, 'claude-opus-5', { turnActive: false })
check('§G4 plain no-op writes nothing', g4.kind === 'no-op' && g4.patch === null && g4.receipt === null)

// §G5 boundary settle applies the parked switch; empty slot returns null
const g5 = settlePendingAtBoundary({ ...base, pendingModelSwitch: { setting: MODEL_B } })
check(
  '§G5 boundary settle applies the parked switch with a turn-boundary receipt',
  g5 !== null && g5.patch.mainLoopModel === MODEL_B && g5.receipt.boundary === 'turn-boundary',
)
check('§G5 empty pending slot settles to null', settlePendingAtBoundary(base) === null)

// §G7 switch-back chains receipts coherently
const afterG1 = { ...base, mainLoopModel: MODEL_B }
const g7 = settleModelSelection(afterG1, 'claude-opus-5', { turnActive: false })
check(
  '§G7 switch-back receipt chains (previous = the switched-to model)',
  g7.kind === 'applied' && g7.receipt?.previous === MODEL_B && g7.receipt?.applied === 'claude-opus-5',
)

// §G8 exactly-once projection: the patch parks the SAME receipt object the
// caller received — the REPL consumer clears by object identity, so one
// settlement can never project twice.
check(
  '§G8 patch parks the receipt by identity (exactly-once consumption)',
  g1.kind === 'applied' && g1.patch?.lastModelTransition === g1.receipt,
)

// §G9 cross-provider flag surfaces in the receipt
const g9 = settleModelSelection(base, 'gpt-5.6-sol', { turnActive: false })
check('§G9 cross-provider switch flagged in the receipt', g9.kind === 'applied' && g9.receipt.crossProvider === true)

// ── §H — pinned child lanes are immune to a leader transition (UN-08) ──────
{
  // Behavioral: the settlement owner's patch is a CLOSED field set — it can
  // only ever write the leader transition slots, so a child lane's pinned
  // identity is unreachable from a leader settle by construction.
  const applied = settleModelSelection(base, MODEL_B, { turnActive: false })
  const ALLOWED = new Set([
    'mainLoopModel',
    'mainLoopModelForSession',
    'pendingModelSwitch',
    'lastModelTransition',
  ])
  const patchKeys = Object.keys(applied.patch ?? {})
  check(
    '§H1 the owner patch is a closed leader-slot set (child state unreachable)',
    patchKeys.length > 0 && patchKeys.every(k => ALLOWED.has(k)),
    patchKeys.join(','),
  )
  // Structural: a child's model is RESOLVED AT SPAWN and rides its own
  // ToolUseContext options — never re-read from the leader's live appState.
  const runAgentSrc = await import('node:fs').then(fs =>
    fs.readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/runAgent.ts'), 'utf8'),
  )
  check(
    '§H2 child model pinned at spawn (runAgent resolvedAgentModel)',
    /mainLoopModel: resolvedAgentModel/.test(runAgentSrc),
  )
}

// ── §I — every projection reads the SAME settled identity (UN-09/06) ───────
{
  const settled = settleModelSelection(base, MODEL_B, { turnActive: false })
  if (settled.kind !== 'applied') throw new Error('§I expects an applied settle')
  // Transcript projection: the receipt row mirrors the receipt exactly and
  // is loggable (⇒ persists ⇒ resume/SDK read the same record).
  const { createModelTransitionMessage } = await import(
    '../../src/utils/messages/systemMessages.ts'
  )
  const row = createModelTransitionMessage(settled.receipt)
  check(
    '§I1 transcript row mirrors the receipt',
    row.subtype === 'model_transition' &&
      row.previous === settled.receipt.previous &&
      row.applied === settled.receipt.applied &&
      row.resolution === 'applied',
  )
  const { isLoggableMessage } = await import('../../src/utils/sessionStorage/chain.ts')
  check('§I2 the row persists (loggable ⇒ transcript/resume/SDK agree)', isLoggableMessage(row as never))
  // Fabric round-trip: the durable record model carries the same facts
  // (entryToRecord → notice payload → recordToEntry).
  const codec = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  let ordN = 0
  const ctx = {
    sessionId: '00000000-0000-4000-8000-000000000001' as never,
    nextOrdinal: () => ordinalOf(++ordN) as never,
    observedAt: '2026-08-05T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  const rec = codec.entryToRecord(
    { ...(row as unknown as Record<string, unknown>), sessionId: ctx.sessionId } as never,
    ctx as never,
  )
  const back = codec.recordToEntry(rec) as Record<string, unknown>
  check(
    '§I3 fabric round-trip preserves the transition facts',
    rec.payload.kind === 'notice' &&
      (rec.payload as { noticeKind?: string }).noticeKind === 'model_transition' &&
      back.subtype === 'model_transition' &&
      back.applied === MODEL_B,
  )
  // The prompt projection already follows the applied identity (§B); the UI
  // reads AppState.mainLoopModel (the same field the patch writes) — one
  // store field, one receipt, one row: the agreement is by construction.
  check(
    '§I4 the patch writes the ONE store field every UI surface reads',
    settled.patch?.mainLoopModel === MODEL_B,
  )
}

console.log(failed === 0 ? '\n ✅ IDENTITY TRANSITION LAWS HOLD' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

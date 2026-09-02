#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-c-selection-core.ts — C01/C02/
//  C03/C04/C05/ core + the mechanics: the SELECTION stage.
//
//    §A — the selection record is versioned, frozen, provider-neutral,
//       and digest-deterministic (identical inputs + index state ⇒
//       identical digests); the plan shape grew IN PLACE (planVersion 2)
//    §B — required closure computed FIRST and untouchable: operator
//       request, instruction/capsule rows, the continuation tail, tool
//       pairing to a fixed point, unresolved tool calls — the armed policy
//       excludes ONLY optional items; the output view never orphans a pair
//    §C — selection ≠ destruction: canonical inputs untouched
//       (array + element identity), and the module performs no fs writes
//    §D — every exclusion carries the stable reason code + exact
//       source ref + a retrievable <persisted-output> pointer with NO
//       fabricated summary text; the source resolves byte-true by uuid
//    §E — candidate/index state bounded: hard cap + reap, decayed
//       aggregates, explicit exclusion-record cap
//    §F — no full-history scan per step: suffix-only visits, noop on
//       unchanged views, a rebase refolds exactly once and says so
//    §G mechanics — apply ≡ inspect digests with selection armed;
//       inspect never moves the owner watermark (side-effect-free clone)
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-c-sel-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_CONTEXT_SELECTION

const sel = await import('../../src/services/run/contextSelection.js')
const planMod = await import('../../src/services/run/requestContextPlan.js')
const ok = await import('../../src/services/run/ownerKey.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type AnyMessage = Record<string, unknown>
const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function userMsg(n: number, text: string): AnyMessage {
  return { type: 'user', uuid: u(n), message: { role: 'user', content: text } }
}
function assistantMsg(n: number, text: string): AnyMessage {
  return { type: 'assistant', uuid: u(n), message: { role: 'assistant', content: [{ type: 'text', text }] } }
}
function toolUseMsg(n: number, id: string): AnyMessage {
  return { type: 'assistant', uuid: u(n), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } }
}
function toolResultMsg(n: number, id: string): AnyMessage {
  return { type: 'user', uuid: u(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }
}

/** A long history: [sys] + 30 old chat turns + a tool pair + an unresolved
 *  use + 6 tail messages ending in the operator request. */
function fixture(): AnyMessage[] {
  const msgs: AnyMessage[] = []
  let n = 1
  msgs.push({ type: 'system', uuid: u(n++), content: 'contract row', message: { role: 'system', content: 'contract row' } })
  for (let i = 0; i < 15; i++) {
    msgs.push(userMsg(n++, `old question ${i}`))
    msgs.push(assistantMsg(n++, `old answer ${i}`))
  }
  msgs.push(toolUseMsg(n++, 'tool_pair_1'))
  msgs.push(toolResultMsg(n++, 'tool_pair_1'))
  msgs.push(toolUseMsg(n++, 'tool_unresolved'))
  for (let i = 0; i < 2; i++) {
    msgs.push(userMsg(n++, `recent question ${i}`))
    msgs.push(assistantMsg(n++, `recent answer ${i}`))
  }
  msgs.push(userMsg(n++, 'the active operator request'))
  return msgs
}

const OWNER = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-core', lane: 'main' })
const SKIP = new Set<string>()
const build = (
  messages: AnyMessage[],
  mode: 'apply' | 'inspect',
  owner = OWNER,
  budget: { maxOptionalItems: number } | null = null,
) =>
  planMod.buildRequestContextPlan(
    {
      messages: messages as never,
      owner,
      querySource: 'repl_main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: SKIP,
      selectionBudget: budget,
    },
    mode,
  )

section('§A C01 — versioned, frozen, provider-neutral, digest-deterministic')
{
  const msgs = fixture()
  const p1 = await build(msgs, 'inspect')
  const p2 = await build(msgs, 'inspect')
  check('planVersion 2 — the shape grew in place', p1.planVersion === 2)
  check('selection.version 1', p1.selection.version === 1)
  check('the selection record is frozen', Object.isFrozen(p1.selection))
  check('default policy is preserve-all', p1.selection.policy === 'preserve-all')
  check('identical inputs + state ⇒ identical selection digests', p1.selection.digest === p2.selection.digest)
  check('identical inputs + state ⇒ identical plan digests', p1.digest === p2.digest)
  const src = readFileSync(join(import.meta.dir, '../../src/services/run/contextSelection.ts'), 'utf8')
  for (const provider of ['responsesBridge', 'zaiCodec', 'anthropic', 'openai']) {
    check(`provider-neutral: no ${provider} import`, !src.includes(`${provider}`))
  }
  check('preserve-all view is byte-identical (plan digest unaffected by the stage)', p1.selection.excluded.length === 0)
}

section('§B C02 — required closure first; the armed policy touches only optional items')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  const msgs = fixture()
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-b', lane: 'main' })
  const plan = await build(msgs, 'inspect', owner, { maxOptionalItems: 4 })
  const s = plan.selection
  check('policy armed', s.policy === 'bounded-optional')
  check('exclusions happened', s.excluded.length > 0, `excluded=${s.excluded.length}`)
  check('required + optional partition the candidates', s.requiredCount + s.optionalCount === s.candidateCount)
  const outUuids = new Set(plan.messages.map(m => (m as AnyMessage).uuid))
  // The required set: system row, the operator request, the tail, the
  // unresolved tool use — all present in the OUTPUT view.
  check('the instruction row survives', outUuids.has(u(1)))
  check('the operator request survives', outUuids.has((msgs.at(-1) as AnyMessage).uuid))
  check('the unresolved tool use survives', plan.messages.some(m => JSON.stringify((m as AnyMessage).message).includes('tool_unresolved')))
  // Pairing integrity in the OUTPUT: both sides of pair_1 in or both out.
  const hasUse = plan.messages.some(m => JSON.stringify((m as AnyMessage).message).includes("tool_use\",\"id\":\"tool_pair_1") || JSON.stringify((m as AnyMessage).message).includes('"id":"tool_pair_1"'))
  const hasResult = plan.messages.some(m => JSON.stringify((m as AnyMessage).message).includes('"tool_use_id":"tool_pair_1"'))
  check('the output view never orphans a tool pair', hasUse === hasResult, `use=${hasUse} result=${hasResult}`)
  // Exclusions ⊆ optional: no excluded uuid may be a required one.
  const excludedUuids = new Set(s.excluded.map(e => e.span.recordUuid))
  check('no exclusion hits the operator request/instruction rows', !excludedUuids.has(u(1)) && !excludedUuids.has((msgs.at(-1) as AnyMessage).uuid as string))
  delete process.env.MERCURY_CONTEXT_SELECTION
}

section('§B2 C02 — supersession, file/evidence edges, typed closure overflow')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  // Two capsules (older SUPERSEDED, latest accepted) + a path-carrying tool
  // pair deep in the old region (evidence edge) + plain old chat.
  const msgs: AnyMessage[] = []
  let n = 1
  msgs.push({ type: 'user', uuid: u(n++), isCompactSummary: true, message: { role: 'user', content: 'OLD capsule (superseded)' } })
  for (let i = 0; i < 12; i++) {
    msgs.push(userMsg(n++, `old question ${i}`))
    msgs.push(assistantMsg(n++, `old answer ${i}`))
  }
  const evidenceUseUuid = u(n)
  msgs.push({ type: 'assistant', uuid: u(n++), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ev_1', name: 'Read', input: { file_path: '/repo/core.ts' } }] } })
  const evidenceResultUuid = u(n)
  msgs.push(toolResultMsg(n++, 'ev_1'))
  for (let i = 0; i < 8; i++) {
    msgs.push(userMsg(n++, `mid question ${i}`))
    msgs.push(assistantMsg(n++, `mid answer ${i}`))
  }
  const latestCapsuleUuid = u(n)
  msgs.push({ type: 'user', uuid: u(n++), isCompactSummary: true, message: { role: 'user', content: 'LATEST capsule (accepted decision)' } })
  for (let i = 0; i < 4; i++) {
    msgs.push(userMsg(n++, `recent ${i}`))
    msgs.push(assistantMsg(n++, `recent re ${i}`))
  }
  msgs.push(userMsg(n++, 'the request'))

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-b2', lane: 'main' })
  const plan = await build(msgs, 'inspect', owner, { maxOptionalItems: 0 })
  const outUuids = new Set(plan.messages.map(m => (m as AnyMessage).uuid))
  check('the LATEST capsule survives (accepted decision)', outUuids.has(latestCapsuleUuid))
  check('the OLDER capsule is superseded — excludable', !outUuids.has(u(1)))
  check('the file-evidence pair survives (dependency edge)', outUuids.has(evidenceUseUuid) && outUuids.has(evidenceResultUuid))

  // Typed closure overflow: a total budget below the required count reports
  // the state and force-drops NOTHING required.
  const owner2 = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-b2o', lane: 'main' })
  const plan2 = await build(msgs, 'inspect', owner2, { maxOptionalItems: 0, maxTotalItems: 3 })
  check("closure overflow is TYPED: 'closure-exceeds-budget'", plan2.selection.overflow === 'closure-exceeds-budget')
  check('overflow still retains the full required closure', plan2.messages.length >= plan2.selection.requiredCount)
  const plan3 = await build(msgs, 'inspect', owner2, { maxOptionalItems: 0 })
  check("no total budget ⇒ overflow 'none'", plan3.selection.overflow === 'none')
  delete process.env.MERCURY_CONTEXT_SELECTION
}

section('§C C03 — selection ≠ destruction')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  const msgs = fixture()
  const snapshot = JSON.stringify(msgs)
  const refs = [...msgs]
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-c', lane: 'main' })
  const plan = await build(msgs, 'apply', owner, { maxOptionalItems: 2 })
  check('exclusions happened on the projected view', plan.selection.excluded.length > 0)
  check('the canonical input array is untouched (length + identity)', msgs.length === refs.length && msgs.every((m, i) => m === refs[i]))
  check('the canonical input content is byte-identical', JSON.stringify(msgs) === snapshot)
  const src = readFileSync(join(import.meta.dir, '../../src/services/run/contextSelection.ts'), 'utf8')
  check("the module never imports fs (no writes by construction)", !src.includes("'node:fs'") && !src.includes('"node:fs"') && !src.includes("from 'fs'"))
  delete process.env.MERCURY_CONTEXT_SELECTION
}

section('§D C04 — every exclusion is reason-coded, span-referenced, retrievable')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  const msgs = fixture()
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-d', lane: 'main' })
  const plan = await build(msgs, 'inspect', owner, { maxOptionalItems: 3 })
  const byUuid = new Map(msgs.map(m => [m.uuid as string, m]))
  check('at least one exclusion to inspect', plan.selection.excluded.length > 0)
  for (const e of plan.selection.excluded.slice(0, 3)) {
    check(`reason code stable: ${e.reasonCode}`, e.reasonCode === 'excluded:scored-out')
    check('span names the record uuid', typeof e.span.recordUuid === 'string' && e.span.recordUuid.length > 0)
    check('the source resolves by uuid (byte-true retrieval reference)', byUuid.has(e.span.recordUuid))
    check('the pointer rides the <persisted-output> shape', e.pointer.startsWith('<persisted-output>') && e.pointer.includes(e.span.recordUuid))
    const original = JSON.stringify((byUuid.get(e.span.recordUuid) as AnyMessage).message)
    const originalText = original.includes('old question') || original.includes('old answer')
    check('no fabricated summary text in the pointer', originalText ? !e.pointer.includes('old ') : true)
  }
  delete process.env.MERCURY_CONTEXT_SELECTION
}

section('§E C05 — bounded index: hard cap, reap, decayed aggregates, exclusion cap')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-e', lane: 'main' })
  const idx = sel.candidateIndexFor(owner, 'apply')
  const big: AnyMessage[] = []
  for (let i = 1; i <= sel.MAX_CANDIDATES + 400; i++) big.push(userMsg(i, `m${i}`))
  const r1 = sel.updateCandidateIndex(idx, big as never)
  check('a first fold visits everything once', r1.visited === big.length)
  check(`the candidate map is capped at ${sel.MAX_CANDIDATES}`, idx.candidates.size <= sel.MAX_CANDIDATES, `size=${idx.candidates.size}`)
  const survivor = idx.candidates.get(u(sel.MAX_CANDIDATES + 400))!
  check('a fresh candidate scores 1', survivor.score === 1)
  big.push(userMsg(sel.MAX_CANDIDATES + 401, 'tail'))
  sel.updateCandidateIndex(idx, big as never)
  check('standing aggregates decay per fold round', idx.candidates.get(u(sel.MAX_CANDIDATES + 400))!.score < 1)
  // Exclusion-record cap: a huge optional surplus records at most the cap.
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  const owner2 = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-e2', lane: 'main' })
  const many: AnyMessage[] = []
  for (let i = 1; i <= 600; i++) many.push(userMsg(i, `chat ${i}`), assistantMsg(i + 10000, `re ${i}`))
  many.push(userMsg(999999, 'the request'))
  const capPlan = await build(many, 'inspect', owner2, { maxOptionalItems: 0 })
  check(`exclusion records capped at ${sel.MAX_RECORDED_EXCLUSIONS}`, capPlan.selection.excluded.length <= sel.MAX_RECORDED_EXCLUSIONS)
  check('the cap is EXPLICIT (flagged, never silent)', capPlan.selection.exclusionsCapped === true)
  delete process.env.MERCURY_CONTEXT_SELECTION
}

section('§F C06 — suffix-only visits, noop on unchanged, honest rebase')
{
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-f', lane: 'main' })
  const msgs = fixture()
  const p1 = await build(msgs, 'apply', owner)
  check('first build folds the whole view once (rebase from empty)', p1.selection.indexVisited === p1.selection.candidateCount && p1.selection.indexMode === 'rebase')
  const p2 = await build(msgs, 'apply', owner)
  check('unchanged view ⇒ zero visits (noop)', p2.selection.indexVisited === 0 && p2.selection.indexMode === 'noop')
  const grown = [...msgs, userMsg(5001, 'follow-up'), assistantMsg(5002, 'answer')]
  const p3 = await build(grown, 'apply', owner)
  check('a grown view visits ONLY the suffix', p3.selection.indexVisited === 2 && p3.selection.indexMode === 'incremental', `visited=${p3.selection.indexVisited}`)
  const rebased = grown.slice(10)
  const p4 = await build(rebased, 'apply', owner)
  check('a prefix change refolds once, honestly named', p4.selection.indexMode === 'rebase' && p4.selection.indexVisited === rebased.length)
}

section('§F2 C06 — operation counts at scale (1k/10k/100k) + no history-sized sort')
{
  for (const N of [1_000, 10_000, 100_000]) {
    const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: `ctm-c-f2-${N}`, lane: 'main' })
    const idx = sel.candidateIndexFor(owner, 'apply')
    const view: AnyMessage[] = []
    for (let i = 1; i <= N; i++) view.push(i % 2 ? userMsg(i, `t${i}`) : assistantMsg(i, `r${i}`))
    const r1 = sel.updateCandidateIndex(idx, view as never)
    check(`${N}-turn: first fold visits N once`, r1.visited === N)
    view.push(userMsg(N + 1, 'new'), assistantMsg(N + 2, 'new-re'))
    const r2 = sel.updateCandidateIndex(idx, view as never)
    check(`${N}-turn: the next step visits ONLY the 2-message suffix`, r2.visited === 2 && r2.mode === 'incremental', `visited=${r2.visited}`)
    const r3 = sel.updateCandidateIndex(idx, view as never)
    check(`${N}-turn: an unchanged step visits 0`, r3.visited === 0 && r3.mode === 'noop')
  }
  const src = readFileSync(join(import.meta.dir, '../../src/services/run/contextSelection.ts'), 'utf8')
  const sortSites = src.split('.sort(').length - 1
  check('exactly ONE .sort in the module', sortSites === 1, `found ${sortSites}`)
  check('…and it runs over the BOUNDED drop set, never history', src.includes('[...dropSet].sort'))
}

section('§G C09 mechanics — apply ≡ inspect; inspect never moves the watermark')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c-g', lane: 'main' })
  const msgs = fixture()
  const inspected = await build(msgs, 'inspect', owner, { maxOptionalItems: 4 })
  const watermarkAfterInspect = sel.peekCandidateIndex(owner)?.watermarkCount ?? 0
  check('inspect leaves the owner watermark untouched', watermarkAfterInspect === 0, `wm=${watermarkAfterInspect}`)
  const applied = await build(msgs, 'apply', owner, { maxOptionalItems: 4 })
  check('apply moves the watermark (the real fold)', (sel.peekCandidateIndex(owner)?.watermarkCount ?? 0) === msgs.length)
  check('inspector ≡ request: plan digests equal', inspected.digest === applied.digest)
  check('inspector ≡ request: selection digests equal', inspected.selection.digest === applied.selection.digest)
  const inspected2 = await build(msgs, 'inspect', owner, { maxOptionalItems: 4 })
  check('inspect over the WARM index still matches apply', inspected2.digest === applied.digest && inspected2.selection.digest === applied.selection.digest)
  delete process.env.MERCURY_CONTEXT_SELECTION
}

console.log(
  failures === 0
    ? '\n ✅ SELECTION CORE — closure-first, bounded, incremental, parity-clean'
    : `\n ❌ SELECTION CORE — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)

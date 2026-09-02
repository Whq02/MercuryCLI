#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-compact-clear — the coordinator REPL's /compact and
//  /clear contracts (chat-relief item 1: compact SUMMARIZES-IN-PLACE).
//
//  THE CONTRACT this pins (superseding the v1 drop-with-marker, which
//  discarded the folded turns' content outright): /compact folds every turn
//  older than the keep tail into ONE summary written by a model call, seats
//  it as a harness-voiced marker in the main chat's compact grammar, and
//  keeps the newest tail verbatim. A fold with no summary NEVER happens —
//  no composed model or a failed call refuses TYPED with the store
//  untouched (relief by amnesia is not relief).
//
//  THE VOICE LAW carries over verbatim: the marker is Mercury's own act and
//  wears harness:true. POISON: a marker without it — the pane speaks it as
//  the coordinator, and the next turn's replay hands the model words it
//  never said (the fabrication class /clear's client-side handling exists
//  to prevent).
//
//    §1 under the keep floor — an honest zero; the summarizer is NEVER
//       invoked (no spend for a no-op)
//    §2 over the floor — the summary marker leads the kept tail: ONE
//       marker, harness:true + summary:true, the landed fold sentence
//       first, the summary text carried, the tail verbatim in order, and
//       the context gauge cleared by the fold
//    §3 the replay — the marker comes back role 'harness' and rides WHOLE
//       (a >600-char summary survives past the per-row clip: the summary
//       IS the folded turns' only memory)
//    §4 refusal honesty — a failing summarizer refuses typed; the store is
//       byte-untouched, no marker, nothing dropped
//    §5 /clear — the store empties (its lifecycle law: births fresh)
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-compact-clear.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'coordinator-compact-'))
const {
  appendCoordinatorConversation,
  clearCoordinatorConversation,
  readCoordinatorConversation,
  readCoordinatorGauge,
  stampCoordinatorGauge,
} = await import('../../src/services/concourse/coordinatorConversation.js')
const { summarizeCoordinatorConversation, coordinatorCompactMarkerLine } = await import(
  '../../src/services/concourse/coordinatorCompact.js'
)
const { buildCoordinatorReplay } = await import('../../src/services/concourse/coordinatorReplay.js')

const entry = (i: number, role: 'operator' | 'coordinator') => ({
  id: `${role === 'operator' ? 'op' : 'co'}:m${i}`,
  role,
  text: `turn ${i} words`,
  ts: 1_700_000_000_000 + i * 1000,
})

// The proof summary: long enough that the per-row replay clip (600) would
// amputate it — §3 pins that it rides whole instead.
const SUMMARY_BODY = `1. Standing asks: the operator wants two refactor sessions watched. ${'ballast '.repeat(90)}end-of-summary-sentinel`

try {
  section('§1 /compact under the keep floor — honest zero, the summarizer never invoked')
  {
    for (let i = 0; i < 4; i++) await appendCoordinatorConversation(entry(i, i % 2 === 0 ? 'operator' : 'coordinator'), scratch)
    let calls = 0
    const r = await summarizeCoordinatorConversation({
      dir: scratch,
      modelId: 'claude-opus-5',
      summarize: async () => {
        calls++
        return 'never'
      },
    })
    check('compacted: 0', r.compacted === 0 && r.refused === undefined, JSON.stringify(r))
    check('the summarizer was NEVER invoked (no spend for a no-op)', calls === 0, String(calls))
    const rows = await readCoordinatorConversation(scratch)
    check('all four rows stand, no marker', rows.length === 4 && rows.every(e => !e.id.startsWith('co:compact:')))
  }

  section('§2 /compact over the floor — the summary marker leads the kept tail')
  {
    for (let i = 4; i < 14; i++) await appendCoordinatorConversation(entry(i, i % 2 === 0 ? 'operator' : 'coordinator'), scratch)
    await stampCoordinatorGauge({ contextTokens: 90_000, modelId: 'claude-opus-5', ts: 1 }, scratch)
    let sawTranscript = ''
    const r = await summarizeCoordinatorConversation({
      dir: scratch,
      modelId: 'claude-opus-5',
      summarize: async ({ transcript }) => {
        sawTranscript = transcript
        return SUMMARY_BODY
      },
    })
    check('the fold count returned (14 − 8)', r.compacted === 6, JSON.stringify(r))
    check('the summarizer read the FOLDED turns (oldest in, newest out)', sawTranscript.includes('turn 0 words') && !sawTranscript.includes('turn 13 words'), sawTranscript.slice(0, 120))
    const rows = await readCoordinatorConversation(scratch)
    check('keep + marker rows stand', rows.length === 9, String(rows.length))
    const marker = rows[0]!
    check('the marker leads the kept tail', marker.id.startsWith('co:compact:'))
    check('THE VOICE LAW: the marker wears harness:true (poison: coordinator-voiced fabrication)', marker.harness === true)
    check('…and the summary flag (the replay rides it whole)', marker.summary === true)
    check(
      'the fold sentence leads, in the main chat’s compact grammar',
      marker.text.startsWith(coordinatorCompactMarkerLine(6)),
      marker.text.slice(0, 80),
    )
    check('the summary text is carried in the marker', marker.text.includes('end-of-summary-sentinel'))
    check('the newest keep survive in order', rows.slice(1).every((e, i) => e.text === `turn ${6 + i} words`), JSON.stringify(rows.slice(1).map(e => e.id)))
    const gauge = await readCoordinatorGauge(scratch)
    check('the context gauge cleared with the fold (counts unknown until the next turn)', gauge === undefined, JSON.stringify(gauge))
  }

  section('§3 the replay speaks the marker as the harness — and WHOLE')
  {
    const rows = await readCoordinatorConversation(scratch)
    const replay = buildCoordinatorReplay(rows, 1_700_000_100_000)
    const markerRow = replay.find(r => r.text.startsWith('conversation compacted'))
    check('the marker reaches the replay tail', markerRow !== undefined)
    check('…as role harness, never coordinator', markerRow?.role === 'harness', markerRow?.role)
    check(
      '…riding WHOLE past the per-row clip (the summary is the folded turns’ only memory)',
      markerRow !== undefined && markerRow.text.includes('end-of-summary-sentinel'),
      `len=${markerRow?.text.length}`,
    )
    const ordinary = replay.find(r => r.text.startsWith('turn '))
    check('ordinary rows keep the bounded-input clip law', ordinary !== undefined && ordinary.text.length <= 600)
  }

  section('§4 refusal honesty — a failing summarizer folds NOTHING')
  {
    for (let i = 14; i < 20; i++) await appendCoordinatorConversation(entry(i, i % 2 === 0 ? 'operator' : 'coordinator'), scratch)
    const before = JSON.stringify(await readCoordinatorConversation(scratch))
    const r = await summarizeCoordinatorConversation({
      dir: scratch,
      modelId: 'claude-opus-5',
      summarize: async () => {
        throw new Error('provider unreachable')
      },
    })
    check('the fold refused typed, naming the failure', r.compacted === 0 && /summary call failed/.test(r.refused ?? ''), JSON.stringify(r))
    check('…and says nothing was folded', /nothing was folded/.test(r.refused ?? ''), r.refused)
    const after = JSON.stringify(await readCoordinatorConversation(scratch))
    check('the store is byte-untouched (no marker, nothing dropped)', before === after)
  }

  section('§5 /clear empties the store')
  {
    await clearCoordinatorConversation(scratch)
    const rows = await readCoordinatorConversation(scratch)
    check('the conversation is empty', rows.length === 0, String(rows.length))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n❌ ${failures} COORDINATOR-COMPACT-CLEAR PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL COORDINATOR-COMPACT-CLEAR PROOFS PASS')

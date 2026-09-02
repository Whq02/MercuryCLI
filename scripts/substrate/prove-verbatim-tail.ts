#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-verbatim-tail.ts
//  PROOF: verbatim recent-tail preservation for full autocompact (arXiv:2606.10209
//  "Less Context, Better Agents" — keep the last N tool-rounds VERBATIM + summarize
//  the rest). On a long ACTIVE run, context is shaped SOLELY by autocompact
//  (cached-MC is DCE'd off; time-based MC only fires after a >60-min idle gap), and
//  today full autocompact keeps a ZERO verbatim tail — losing recent reasoning /
//  outputs to the summary. This feature preserves the recent rounds across the
//  boundary, reusing the proven preservedSegment relink that partial /compact uses.
//
//  verbatimTail.ts is bun:bundle/feature()-FREE ⇒ a LIVE proof of the pure logic.
//  The wiring section greps compact.ts / REPL.tsx for the integration points.
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-verbatim-tail.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// stamp-sim (the build stamp reads MACRO.VERSION) — the feature is stamp-gated.
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const {
  computeVerbatimRecentTail,
  isMercuryCompactKeepTailEnabled,
  DEFAULT_KEEP_ROUNDS,
  MIN_HEAD_ROUNDS,
  MAX_FLOOR_ROUND_TOKENS,
} = await import('../../src/services/compact/verbatimTail.js')

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const TS = '2026-01-01T00:00:00.000Z'
let seq = 0
const uid = (): string => `u-${seq++}`
type M = Record<string, unknown>

function mkAssistant(round: number, toolUseId: string, text = 'work'): M {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: TS,
    message: {
      id: `asst-${round}`,
      role: 'assistant',
      type: 'message',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } },
      ],
    },
  }
}
function mkToolResult(toolUseId: string, out: string): M {
  return {
    type: 'user',
    uuid: uid(),
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: out }] },
  }
}
function mkRound(i: number, out = 'ok'): M[] {
  const tid = `tu-${i}`
  return [mkAssistant(i, tid), mkToolResult(tid, out)]
}
function rounds(n: number, out = 'ok'): M[] {
  const a: M[] = []
  for (let i = 0; i < n; i++) a.push(...mkRound(i, out))
  return a
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (msgs: M[], opts?: any) => computeVerbatimRecentTail(msgs as any, opts)

console.log('============================================================')
console.log(' verbatim recent-tail preservation for autocompact')
console.log('============================================================')

// ── (a) the gate: default-ON for fork, opt-out wins, opt-in overrides substrate-off ──
section('(a) gate — default-ON for fork (substrate), MERCURY_COMPACT_KEEP_TAIL=0 opt-out')
{
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  delete process.env.MERCURY_CTX_COMPACTION
  delete process.env.MERCURY_SUBSTRATE
  check('fork default (substrate on) ⇒ enabled', isMercuryCompactKeepTailEnabled() === true)

  process.env.MERCURY_COMPACT_KEEP_TAIL = '0'
  check('MERCURY_COMPACT_KEEP_TAIL=0 ⇒ disabled (opt-out wins)', isMercuryCompactKeepTailEnabled() === false)
  process.env.MERCURY_COMPACT_KEEP_TAIL = 'false'
  check('MERCURY_COMPACT_KEEP_TAIL=false ⇒ disabled', isMercuryCompactKeepTailEnabled() === false)
  delete process.env.MERCURY_COMPACT_KEEP_TAIL

  process.env.MERCURY_SUBSTRATE = '0'
  check('MERCURY_SUBSTRATE=0 (no opt-in) ⇒ disabled (byte-identical)', isMercuryCompactKeepTailEnabled() === false)
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  check('explicit MERCURY_COMPACT_KEEP_TAIL=1 overrides substrate-off', isMercuryCompactKeepTailEnabled() === true)
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  process.env.MERCURY_CTX_COMPACTION = '1'
  check('explicit MERCURY_CTX_COMPACTION=1 also enables', isMercuryCompactKeepTailEnabled() === true)
  delete process.env.MERCURY_CTX_COMPACTION
  delete process.env.MERCURY_SUBSTRATE

  ;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '0.0.0-src' } // default-shaped stamp
  // the default is stamp-independent.
  check('bare stamp ⇒ STILL enabled (stamp-independence)', isMercuryCompactKeepTailEnabled() === true)
  ;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
}

// ── (b) keeps the last DEFAULT_KEEP_ROUNDS whole rounds as a contiguous suffix ──
section('(b) keeps the last N whole rounds, contiguous suffix, head-anchored')
{
  const msgs = rounds(10)
  const r = call(msgs)
  check('result is non-null with a substantial head', r !== null)
  check(`keeps exactly DEFAULT_KEEP_ROUNDS (${DEFAULT_KEEP_ROUNDS}) rounds`, r!.roundsKept === DEFAULT_KEEP_ROUNDS)
  // keep is a contiguous suffix of msgs (so the on-disk parentUuid chain is intact)
  const firstKeptUuid = (r!.keep[0] as M).uuid
  const firstIdx = msgs.findIndex(m => (m as M).uuid === firstKeptUuid)
  const suffix = msgs.slice(firstIdx)
  check('keep == contiguous suffix from keep[0]', JSON.stringify(r!.keep) === JSON.stringify(suffix))
  check('keep[0] is a round-start (assistant) ⇒ no leading orphaned tool_result', (r!.keep[0] as M).type === 'assistant')
  // precedingUuid is the message immediately before the kept tail (the boundary's anchor parent)
  check('precedingUuid == msgs[firstIdx-1].uuid', r!.precedingUuid === (msgs[firstIdx - 1] as M).uuid)
}

// ── (c) tool_use/tool_result pairing is closed within the kept tail ────────────
section('(c) every tool_result in the kept tail has its tool_use in the kept tail')
{
  const r = call(rounds(12))
  const useIds = new Set<string>()
  const resultIds: string[] = []
  for (const m of r!.keep as M[]) {
    const content = (m as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') useIds.add(b.id as string)
      if (b.type === 'tool_result') resultIds.push(b.tool_use_id as string)
    }
  }
  check('at least one tool_result is preserved', resultIds.length > 0)
  check('no orphaned tool_result (all paired within keep)', resultIds.every(id => useIds.has(id)))
}

// ── (d) the engage guard: too few rounds ⇒ null (behaves exactly as today) ─────
section('(d) engage guard — fewer than keepRounds + MIN_HEAD_ROUNDS ⇒ null')
{
  check(`${DEFAULT_KEEP_ROUNDS} rounds (no head) ⇒ null`, call(rounds(DEFAULT_KEEP_ROUNDS)) === null)
  check(
    `keepRounds + MIN_HEAD_ROUNDS - 1 (=${DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS - 1}) ⇒ null`,
    call(rounds(DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS - 1)) === null,
  )
  check(
    `keepRounds + MIN_HEAD_ROUNDS (=${DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS}) ⇒ engages`,
    call(rounds(DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS)) !== null,
  )
  check('1 round ⇒ null', call(rounds(1)) === null)
  check('0 messages ⇒ null', call([]) === null)
}

// ── (e) token-budget cap: drops oldest whole rounds; never drops below 1 ───────
section('(e) token-budget cap drops OLDEST whole rounds; floor = 1 round')
{
  // 10 small rounds, but a tiny budget ⇒ keeps fewer than DEFAULT_KEEP_ROUNDS.
  const big = 'x'.repeat(8_000) // ~2K tokens/round
  const capped = call(rounds(10, big), { tailTokenBudget: 5_000 })
  check('tiny budget ⇒ fewer rounds kept than the round cap', capped!.roundsKept < DEFAULT_KEEP_ROUNDS, `kept=${capped!.roundsKept}`)
  check('tiny budget ⇒ still keeps at least 1 round', capped!.roundsKept >= 1)
  // floor: the most-recent round alone exceeds the SOFT budget ⇒ keep exactly 1.
  // Sized over the 15K soft budget but UNDER the 30K hard ceiling (section (f2)
  // covers the over-ceiling skip), so the floor-keeps-one-round contract applies.
  const msgs = rounds(10, 'ok')
  // make the LAST round large-but-bounded (~20K tokens)
  const giant = mkRound(99, 'y'.repeat(80_000))
  msgs.push(...giant)
  const floored = call(msgs, { tailTokenBudget: 15_000 })
  check('a single over-soft-budget most-recent round ⇒ keep exactly 1 round', floored!.roundsKept === 1, `kept=${floored!.roundsKept}`)
  check('the kept round is the most-recent (giant) one', JSON.stringify(floored!.keep) === JSON.stringify(giant))
}

// ── (f) filters progress / old boundary / old summary out of the kept tail ────
section('(f) non-preservable messages (progress / boundary / summary) are filtered')
{
  const msgs = rounds(10)
  // splice a progress, an old compact boundary, and an old summary into the tail region
  msgs.push({ type: 'progress', uuid: uid(), timestamp: TS, data: { type: 'tool_progress' } } as M)
  msgs.push({ type: 'system', subtype: 'compact_boundary', uuid: uid(), timestamp: TS, content: 'x', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 0 } } as M)
  msgs.push({ type: 'user', uuid: uid(), timestamp: TS, isCompactSummary: true, message: { role: 'user', content: 'old summary' } } as M)
  msgs.push(...mkRound(100)) // a real most-recent round after the junk
  const r = call(msgs)
  check('result non-null', r !== null)
  const kept = r!.keep as M[]
  check('no progress message in keep', !kept.some(m => m.type === 'progress'))
  check('no compact_boundary in keep', !kept.some(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary'))
  check('no isCompactSummary user message in keep', !kept.some(m => m.type === 'user' && (m as { isCompactSummary?: boolean }).isCompactSummary === true))
  check('the real most-recent round IS preserved', kept.some(m => (m as { message?: { id?: string } }).message?.id === 'asst-100'))
}

// ── (f2) floor-round HARD ceiling: a byte-huge most-recent round skips the tail ──
section('(f2) floor-round ceiling — a single byte-huge round falls back to summary-only')
{
  const CEIL = MAX_FLOOR_ROUND_TOKENS as number
  check('MAX_FLOOR_ROUND_TOKENS is a positive bound', typeof CEIL === 'number' && CEIL > 0)

  // ~4 chars/token. A floor round whose lone tool_result is OVER the ceiling.
  const overChars = (CEIL + 6_000) * 4
  const underChars = (CEIL - 6_000) * 4

  // 10 rounds, all tiny except the MOST-RECENT which carries a giant tool_result.
  // The budget loop drops the tiny olders down to the single huge floor round; the
  // ceiling guard then trips ⇒ null (compaction proceeds summary-only, no thrash).
  {
    const msgs: M[] = []
    for (let i = 0; i < 9; i++) msgs.push(...mkRound(i, 'ok'))
    msgs.push(...mkRound(99, 'X'.repeat(overChars))) // pathological floor round
    const r = call(msgs)
    check('floor round > ceiling ⇒ null (tail skipped, summary-only fallback)', r === null)
  }

  // Same shape but the floor round sits UNDER the ceiling: the floor is still kept
  // even though it exceeds the 15K soft budget (the floor-keeps-one-round contract).
  {
    const msgs: M[] = []
    for (let i = 0; i < 9; i++) msgs.push(...mkRound(i, 'ok'))
    msgs.push(...mkRound(98, 'Y'.repeat(underChars))) // large-but-bounded floor round
    const r = call(msgs)
    check('floor round ≤ ceiling ⇒ kept past the soft budget (floor contract holds)', r !== null && r!.roundsKept === 1)
    check('the kept floor round is the most-recent one', r !== null && (r!.keep as M[]).some(m => (m as { message?: { id?: string } }).message?.id === 'asst-98'))
  }
}

// ── (f3) base64-aware ceiling: a huge image/document floor round is NOT dropped ──
section('(f3) floor-round ceiling is base64-aware — an image/PDF round stays under the ceiling')
{
  // A most-recent round whose tool_result holds a just-read screenshot: ~200K base64
  // chars in the record (JSON.stringify/4 ≈ 50K "tokens") but the API charges ~2000.
  // The base64-BLIND estimate would trip the 30K ceiling and DROP the screenshot tail
  // (the regression); the base64-aware estimate counts the image at the flat rate so
  // the round stays well under the ceiling and is preserved.
  const bigImageData = 'A'.repeat(200_000)
  const imageRound = (): M[] => {
    const tid = `tu-img`
    return [
      mkAssistant(77, tid, 'reading the screenshot'),
      {
        type: 'user',
        uuid: uid(),
        timestamp: TS,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: tid,
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigImageData } },
              ],
            },
          ],
        },
      } as M,
    ]
  }
  // A tiny budget drops the leading rounds down to the LONE image round, so the ceiling
  // guard evaluates IT (the sharp case: with the base64-blind estimate the image round
  // alone reads as ~50K > the 30K ceiling ⇒ the whole tail would be dropped to null).
  const msgs: M[] = []
  for (let i = 0; i < 9; i++) msgs.push(...mkRound(i, 'ok'))
  msgs.push(...imageRound())
  const r = call(msgs, { tailTokenBudget: 1000 })
  check('the lone image floor round survives the ceiling (base64 counted at the flat rate, not ~50K)', r !== null && r!.roundsKept === 1)
  check('the preserved round is the image round (the screenshot the user just added)', r !== null && (r!.keep as M[]).some(m => (m as { message?: { id?: string } }).message?.id === 'asst-77'))
}

// ── (g) wiring intact: producer (compact.ts) + dedup fix (REPL.tsx) ────────────
section('(g) wiring — compact.ts populates messagesToKeep + relink; REPL dedups the tail')
{
  const root = join(import.meta.dir, '..', '..')
  const compact = readFileSync(join(root, 'src/services/compact/compact.ts'), 'utf-8')
  check('compact.ts imports computeVerbatimRecentTail', compact.includes('computeVerbatimRecentTail'))
  check('compact.ts gates on isMercuryCompactKeepTailEnabled', compact.includes('isMercuryCompactKeepTailEnabled()'))
  check('compact.ts annotates the boundary with the summary anchor', compact.includes('annotateBoundaryWithPreservedSegment(') && compact.includes('summaryMessages.at(-1)!.uuid'))
  check('compact.ts returns messagesToKeep on the full path', /messagesToKeep,\s*\n\s*attachments: postCompactFileAttachments/.test(compact))
  // The spread form `...(messagesToKeep ?? [])` is unique to the truePostCompact
  // estimate (the file/delta dedup sites use the non-spread `messagesToKeep ?? []`).
  check('compact.ts counts the tail in truePostCompactTokenCount', compact.includes('...(messagesToKeep ?? []),'))
  check('compact.ts passes recentMessagesPreserved to the summary message', compact.includes('/* recentMessagesPreserved */ !!messagesToKeep'))

  const repl = readFileSync(join(root, 'src/screens/REPL.tsx'), 'utf-8')
  // The face paints the focused session's chain from its transcript file
  // (the connector rebuilds the records on every reload); the compaction
  // scrollback trim rode the engine's in-memory append and left with it —
  // a trim at the connector's chain read is a named follow-up, and its
  // return lands here deliberately.
  check('the face holds no in-memory scrollback trim (the connector rebuilds the chain from the file)', !repl.includes('retainFullscreenScrollback('))
}

console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL VERBATIM-TAIL PROOFS PASS')
else console.log(`❌ ${fail} VERBATIM-TAIL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)

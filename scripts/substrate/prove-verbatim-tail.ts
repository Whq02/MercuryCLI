#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const {
  computeVerbatimRecentTail,
  isMercuryCompactKeepTailEnabled,
  DEFAULT_KEEP_ROUNDS,
  DEFAULT_TAIL_TOKEN_BUDGET,
  MIN_HEAD_ROUNDS,
  MAX_FLOOR_ROUND_TOKENS,
} = await import('../../src/services/compact/verbatimTail.js')
const { roughTokenCountEstimationForMessages } = await import('../../src/services/tokenEstimation.js')

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

section('(a) gate — default-ON (substrate), MERCURY_COMPACT_KEEP_TAIL=0 opt-out')
{
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  delete process.env.MERCURY_CTX_COMPACTION
  delete process.env.MERCURY_SUBSTRATE
  check('default (substrate on) ⇒ enabled', isMercuryCompactKeepTailEnabled() === true)

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

  ;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '0.0.0-src' }

  check('bare stamp ⇒ STILL enabled (stamp-independence)', isMercuryCompactKeepTailEnabled() === true)
  ;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
}

section('(b) keeps the last N whole rounds, contiguous suffix, head-anchored')
{
  check(`DEFAULT_KEEP_ROUNDS is the measured ten`, DEFAULT_KEEP_ROUNDS === 10)
  const msgs = rounds(DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS)
  const r = call(msgs)
  check('result is non-null with a substantial head', r !== null)
  check(`keeps exactly DEFAULT_KEEP_ROUNDS (${DEFAULT_KEEP_ROUNDS}) rounds`, r!.roundsKept === DEFAULT_KEEP_ROUNDS)
  check('the receipt names the requested count and that it fit', r!.roundsRequested === DEFAULT_KEEP_ROUNDS && r!.reason === 'requested-rounds-fit')
  check('the receipt carries the canonical estimate of the kept rows', r!.estimatedTokens === roughTokenCountEstimationForMessages(r!.keep))
  const firstKeptUuid = (r!.keep[0] as M).uuid
  const firstIdx = msgs.findIndex(m => (m as M).uuid === firstKeptUuid)
  const suffix = msgs.slice(firstIdx)
  check('keep == contiguous suffix from keep[0]', JSON.stringify(r!.keep) === JSON.stringify(suffix))
  check('keep[0] is a round-start (assistant) ⇒ no leading orphaned tool_result', (r!.keep[0] as M).type === 'assistant')
  check('precedingUuid == msgs[firstIdx-1].uuid', r!.precedingUuid === (msgs[firstIdx - 1] as M).uuid)
}

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

section('(d) engage guard — the head keeps MIN_HEAD_ROUNDS; fewer available rounds are kept and named')
{
  const short = call(rounds(DEFAULT_KEEP_ROUNDS))
  check(
    `${DEFAULT_KEEP_ROUNDS} rounds ⇒ keeps ${DEFAULT_KEEP_ROUNDS - MIN_HEAD_ROUNDS} and says so`,
    short !== null && short.roundsKept === DEFAULT_KEEP_ROUNDS - MIN_HEAD_ROUNDS && short.reason === 'available-rounds' && short.roundsRequested === DEFAULT_KEEP_ROUNDS,
    `kept=${short?.roundsKept} reason=${short?.reason}`,
  )
  const nearly = call(rounds(DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS - 1))
  check(
    `keepRounds + MIN_HEAD_ROUNDS - 1 (=${DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS - 1}) ⇒ keeps ${DEFAULT_KEEP_ROUNDS - 1}, named available-rounds`,
    nearly !== null && nearly.roundsKept === DEFAULT_KEEP_ROUNDS - 1 && nearly.reason === 'available-rounds',
  )
  const full = call(rounds(DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS))
  check(
    `keepRounds + MIN_HEAD_ROUNDS (=${DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS}) ⇒ the requested ten fit`,
    full !== null && full.roundsKept === DEFAULT_KEEP_ROUNDS && full.reason === 'requested-rounds-fit',
  )
  const one = call(rounds(MIN_HEAD_ROUNDS + 1))
  check(`MIN_HEAD_ROUNDS + 1 (=${MIN_HEAD_ROUNDS + 1}) rounds ⇒ one round kept behind a two-round head`, one !== null && one.roundsKept === 1 && one.reason === 'available-rounds')
  check(`MIN_HEAD_ROUNDS (=${MIN_HEAD_ROUNDS}) rounds ⇒ null (nothing beyond the head)`, call(rounds(MIN_HEAD_ROUNDS)) === null)
  check('1 round ⇒ null', call(rounds(1)) === null)
  check('0 messages ⇒ null', call([]) === null)
  const open = rounds(DEFAULT_KEEP_ROUNDS + MIN_HEAD_ROUNDS)
  open.push(mkAssistant(500, 'tu-open'))
  let refusal = ''
  try { call(open) } catch (error) { refusal = String((error as Error).message) }
  check('an unresolved most-recent round is refused, the original context kept', /incomplete/.test(refusal) && /original context is kept/.test(refusal), refusal)
}

section('(e) explicit budget — the largest closed suffix that fits, the exact count named; no silent over-budget floor')
{
  check('no soft tail budget stands apart from the request fit', DEFAULT_TAIL_TOKEN_BUDGET === Infinity)
  const big = 'x'.repeat(8_000)
  const capped = call(rounds(12, big), { tailTokenBudget: 5_000 })
  check('tiny budget ⇒ fewer rounds kept than the round cap', capped!.roundsKept < DEFAULT_KEEP_ROUNDS, `kept=${capped!.roundsKept}`)
  check('tiny budget ⇒ still keeps at least 1 round', capped!.roundsKept >= 1)
  check('the kept suffix is under the budget and named request-budget', capped!.estimatedTokens <= 5_000 && capped!.reason === 'request-budget', `tokens=${capped!.estimatedTokens}`)
  check('one more round would not have fit', capped!.estimatedTokens + roughTokenCountEstimationForMessages(mkRound(0, big) as never) > 5_000)
  const msgs = rounds(10, 'ok')
  const giant = mkRound(99, 'y'.repeat(80_000))
  msgs.push(...giant)
  const giantTokens = roughTokenCountEstimationForMessages(giant as never)
  const exact = call(msgs, { tailTokenBudget: giantTokens })
  check('a budget that admits only the most-recent round ⇒ keep exactly 1 round', exact!.roundsKept === 1, `kept=${exact!.roundsKept}`)
  check('the kept round is the most-recent (giant) one', JSON.stringify(exact!.keep) === JSON.stringify(giant))
  let refusal = ''
  try { call(msgs, { tailTokenBudget: giantTokens - 1 }) } catch (error) { refusal = String((error as Error).message) }
  check('when even the latest complete round does not fit, the fold refuses and keeps the original context', /original context is kept/.test(refusal), refusal)
}

section('(f) non-preservable messages (progress / boundary / summary) are filtered')
{
  const msgs = rounds(10)

  msgs.push({ type: 'progress', uuid: uid(), timestamp: TS, data: { type: 'tool_progress' } } as M)
  msgs.push({ type: 'system', subtype: 'compact_boundary', uuid: uid(), timestamp: TS, content: 'x', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 0 } } as M)
  msgs.push({ type: 'user', uuid: uid(), timestamp: TS, isCompactSummary: true, message: { role: 'user', content: 'old summary' } } as M)
  msgs.push(...mkRound(100))
  const r = call(msgs)
  check('result non-null', r !== null)
  const kept = r!.keep as M[]
  check('no progress message in keep', !kept.some(m => m.type === 'progress'))
  check('no compact_boundary in keep', !kept.some(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary'))
  check('no isCompactSummary user message in keep', !kept.some(m => m.type === 'user' && (m as { isCompactSummary?: boolean }).isCompactSummary === true))
  check('the real most-recent round IS preserved', kept.some(m => (m as { message?: { id?: string } }).message?.id === 'asst-100'))
}

section('(f2) no floor-round ceiling — a byte-huge round is kept when the request fits, refused with the old context when it does not')
{
  check('MAX_FLOOR_ROUND_TOKENS no longer bounds a round apart from the request fit', MAX_FLOOR_ROUND_TOKENS === Infinity)
  const hugeChars = 200_000 * 4
  {
    const msgs: M[] = []
    for (let i = 0; i < 9; i++) msgs.push(...mkRound(i, 'ok'))
    msgs.push(...mkRound(99, 'X'.repeat(hugeChars)))
    const r = call(msgs)
    check('a byte-huge most-recent round with no fit limit ⇒ kept verbatim with the rounds before it', r !== null && r!.roundsKept === 10 - MIN_HEAD_ROUNDS, `kept=${r?.roundsKept}`)
    check('the huge round is in the kept tail', r !== null && (r!.keep as M[]).some(m => (m as { message?: { id?: string } }).message?.id === 'asst-99'))
    const narrowed = call(msgs, { fits: keep => keep.length <= 6 })
    check('a request fit that holds three rounds ⇒ exactly three, named request-budget', narrowed !== null && narrowed.roundsKept === 3 && narrowed.reason === 'request-budget', `kept=${narrowed?.roundsKept}`)
    let refusal = ''
    try { call(msgs, { fits: () => false }) } catch (error) { refusal = String((error as Error).message) }
    check('a request fit that holds no complete round ⇒ typed refusal, the original context kept (no silent summary-only fold)', /original context is kept/.test(refusal), refusal)
  }
  {
    const msgs: M[] = []
    for (let i = 0; i < 9; i++) msgs.push(...mkRound(i, 'ok'))
    const last = mkRound(98, 'Y'.repeat(hugeChars))
    msgs.push(...last)
    const r = call(msgs, { tailTokenBudget: roughTokenCountEstimationForMessages(last as never) })
    check('a budget sized to the huge round alone ⇒ exactly that round kept', r !== null && r!.roundsKept === 1)
    check('the kept round is the most-recent one', r !== null && (r!.keep as M[]).some(m => (m as { message?: { id?: string } }).message?.id === 'asst-98'))
  }
}

section('(f3) the fit is base64-aware — an image/PDF round is counted at the flat rate, not its base64 bytes')
{
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
  const msgs: M[] = []
  for (let i = 0; i < 9; i++) msgs.push(...mkRound(i, 'ok'))
  const image = imageRound()
  msgs.push(...image)
  const imageTokens = roughTokenCountEstimationForMessages(image as never)
  check('the image round is counted at the flat media rate, not its ~50K base64 chars/4', imageTokens < 3_000 && imageTokens >= 2_000, `tokens=${imageTokens}`)
  const r = call(msgs, { tailTokenBudget: imageTokens })
  check('a budget sized to the flat rate keeps the lone image round (a base64-blind count would have refused it)', r !== null && r!.roundsKept === 1 && r!.estimatedTokens === imageTokens)
  check('the preserved round is the image round (the screenshot the user just added)', r !== null && (r!.keep as M[]).some(m => (m as { message?: { id?: string } }).message?.id === 'asst-77'))
}

section('(g) wiring — compact.ts populates messagesToKeep + relink; Chat dedups the tail')
{
  const root = join(import.meta.dir, '..', '..')
  const compact = readFileSync(join(root, 'src/services/compact/compact.ts'), 'utf-8')
  check('compact.ts imports computeVerbatimRecentTail', compact.includes('computeVerbatimRecentTail'))
  check('compact.ts gates on isMercuryCompactKeepTailEnabled', compact.includes('isMercuryCompactKeepTailEnabled()'))
  check('compact.ts annotates the boundary with the summary anchor', compact.includes('annotateBoundaryWithPreservedSegment(') && compact.includes('summaryMessages.at(-1)!.uuid'))
  check('compact.ts returns messagesToKeep on the full path', /messagesToKeep,\s*\n\s*attachments: postCompactFileAttachments/.test(compact))

  check('compact.ts counts the tail in truePostCompactTokenCount', compact.includes('...(messagesToKeep ?? []),'))
  check(
    'compact.ts passes the preserved-tail flag (!!messagesToKeep) into the summary message, the newest-message-follows flag beside it',
    /getCompactUserSummaryMessage\(\s*summaryWithCapsule,\s*suppressFollowUpQuestions,\s*getTranscriptPath\(\),[\s\S]{0,80}?!!messagesToKeep,\s*newestMessageFollows,\s*\)/.test(compact),
  )

  const repl = readFileSync(join(root, 'src/screens/Chat.tsx'), 'utf-8')

  check('the face holds no in-memory scrollback trim (the connector rebuilds the chain from the file)', !repl.includes('retainFullscreenScrollback('))
}

console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL VERBATIM-TAIL PROOFS PASS')
else console.log(`❌ ${fail} VERBATIM-TAIL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)

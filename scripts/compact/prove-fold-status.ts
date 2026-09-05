#!/usr/bin/env bun
import { chdir } from 'node:process'
import { join } from 'node:path'

chdir(join(import.meta.dir, '..', '..'))

const {
  FOLD_BAR_CELLS_PER_STAGE,
  FOLD_EXIT_LINGER_MS,
  FOLD_STAMP_THROTTLE_MS,
  beginFoldStatus,
  decodeFoldStatus,
  foldBarCells,
  foldBarText,
  foldRowVisible,
  foldRowWords,
  foldStatusExit,
  foldStatusOnEvent,
} = await import('../../src/services/compact/foldStatus.ts')
const { withFoldStatus, ERROR_MESSAGE_USER_ABORT } = await import('../../src/services/compact/compact.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('fold status — the one owner of the row, pure')

console.log('\nS1 the stages follow the road')
{
  const manual = beginFoldStatus({ trigger: 'manual', startedAtMs: 1000, sessionMemory: true, microcompaction: true })
  check('the /compact road with session memory armed walks four stages in order', manual.stages.join(',') === 'session-memory,micro-compaction,summarising,restoring', manual.stages.join(','))
  const bare = beginFoldStatus({ trigger: 'manual', startedAtMs: 1000, sessionMemory: false, microcompaction: true })
  check('with session memory off the wait is no stage', bare.stages.join(',') === 'micro-compaction,summarising,restoring', bare.stages.join(','))
  const auto = beginFoldStatus({ trigger: 'auto', startedAtMs: 1000, sessionMemory: false, microcompaction: false })
  check('the automatic road walks the summary and the restore', auto.stages.join(',') === 'summarising,restoring', auto.stages.join(','))
  check('a fresh record has no stage, no fill, attempt one', manual.stage === null && manual.fill === null && manual.attempt === 1 && manual.summaryTokens === 0)
  check('the cap is the summariser\'s output ceiling', manual.summaryCapTokens === 20_000, String(manual.summaryCapTokens))
}

console.log('\nS2 the reducer only advances')
{
  let s = beginFoldStatus({ trigger: 'manual', startedAtMs: 1000, sessionMemory: true, microcompaction: true })
  s = foldStatusOnEvent(s, { type: 'stage', stage: 'session-memory' })
  check('the first stage word lands', s.stage === 'session-memory')
  s = foldStatusOnEvent(s, { type: 'stage', stage: 'micro-compaction' })
  check('the next stage word advances', s.stage === 'micro-compaction')
  const back = foldStatusOnEvent(s, { type: 'stage', stage: 'session-memory' })
  check('an earlier stage word never moves the stage back', back.stage === 'micro-compaction')
  s = foldStatusOnEvent(s, { type: 'hooks_start', hookType: 'pre_compact' })
  check('the pre-compact hook is part of the prelude (no stage move)', s.stage === 'micro-compaction')
  s = foldStatusOnEvent(s, { type: 'compact_start' })
  check('compact_start is the summarising stage', s.stage === 'summarising' && s.fill === null)
  s = foldStatusOnEvent(s, { type: 'summary_progress', chars: 4000 })
  check('the summary\'s chars measure the fill against the cap (1000 tokens of 20000)', s.fill !== null && Math.abs(s.fill - 0.05) < 1e-9 && s.summaryTokens === 1000, JSON.stringify({ fill: s.fill, tokens: s.summaryTokens }))
  s = foldStatusOnEvent(s, { type: 'retry', attempt: 2 })
  s = foldStatusOnEvent(s, { type: 'summary_progress', chars: 400 })
  check('a retry restarts the count but the fill holds its mark (never backwards)', s.attempt === 2 && s.summaryTokens === 100 && s.fill !== null && Math.abs(s.fill - 0.05) < 1e-9, JSON.stringify({ fill: s.fill, tokens: s.summaryTokens, attempt: s.attempt }))
  const lower = foldStatusOnEvent(s, { type: 'retry', attempt: 1 })
  check('an attempt number never lowers', lower.attempt === 2)
  s = foldStatusOnEvent(s, { type: 'summary_progress', chars: 200_000 })
  check('the fill clamps at one', s.fill === 1)
  s = foldStatusOnEvent(s, { type: 'stage', stage: 'restoring' })
  check('the restoring stage lands with a fresh (indeterminate) fill', s.stage === 'restoring' && s.fill === null)
  const foreign = foldStatusOnEvent(beginFoldStatus({ trigger: 'auto', startedAtMs: 1, sessionMemory: false, microcompaction: false }), { type: 'stage', stage: 'micro-compaction' })
  check('a stage word the road never walks is ignored', foreign.stage === null)
  const viaHook = foldStatusOnEvent(beginFoldStatus({ trigger: 'auto', startedAtMs: 1, sessionMemory: false, microcompaction: false }), { type: 'hooks_start', hookType: 'session_start' })
  check('the session-start hook is the restoring stage', viaHook.stage === 'restoring')
  const restoringReset = foldStatusOnEvent(s, { type: 'summary_progress', chars: 0 })
  check('the counter\'s reset after the summary landed leaves the restoring record as it stands', restoringReset === s)
  const exited = foldStatusExit(s, 'landed', 9000)
  const after = foldStatusOnEvent(exited, { type: 'summary_progress', chars: 1 })
  check('an exited record is inert', after === exited && exited.exit === 'landed' && exited.endedAtMs === 9000)
  check('compact_end moves nothing (the exit is the finally\'s)', foldStatusOnEvent(s, { type: 'compact_end' }).stage === 'restoring')
}

console.log('\nS3 the bar is honest')
{
  const per = FOLD_BAR_CELLS_PER_STAGE
  let s = beginFoldStatus({ trigger: 'manual', startedAtMs: 0, sessionMemory: false, microcompaction: true })
  check('three cells a stage', per === 3 && foldBarCells(s).length === 9)
  check('before the first stage word the first cell pulses, the rest is empty', foldBarText(foldBarCells(s)) === '◐░░░░░░░░', foldBarText(foldBarCells(s)))
  s = foldStatusOnEvent(s, { type: 'stage', stage: 'micro-compaction' })
  check('a stage in flight with no measure pulses its segment', foldBarText(foldBarCells(s)) === '◐░░░░░░░░')
  s = foldStatusOnEvent(s, { type: 'compact_start' })
  check('a walked stage is full; the summarising segment pulses until a token lands', foldBarText(foldBarCells(s)) === '███◐░░░░░', foldBarText(foldBarCells(s)))
  s = foldStatusOnEvent(s, { type: 'summary_progress', chars: 40_000 })
  check('half the cap fills two of the segment\'s three cells', foldBarText(foldBarCells(s)) === '█████░░░░', foldBarText(foldBarCells(s)))
  const tiny = foldStatusOnEvent(foldStatusOnEvent(beginFoldStatus({ trigger: 'manual', startedAtMs: 0, sessionMemory: false, microcompaction: true }), { type: 'compact_start' }), { type: 'summary_progress', chars: 40 })
  check('a measured fill too small for a cell pulses — never a fake fill', foldBarText(foldBarCells(tiny)) === '███◐░░░░░', foldBarText(foldBarCells(tiny)))
  s = foldStatusOnEvent(s, { type: 'stage', stage: 'restoring' })
  check('the restore pulses after the summary', foldBarText(foldBarCells(s)) === '██████◐░░', foldBarText(foldBarCells(s)))
  const landed = foldStatusExit(s, 'landed', 10)
  check('a landed fold\'s bar is full', foldBarText(foldBarCells(landed)) === '█████████')
  const cancelled = foldStatusExit(foldStatusOnEvent(foldStatusOnEvent(beginFoldStatus({ trigger: 'manual', startedAtMs: 0, sessionMemory: false, microcompaction: true }), { type: 'compact_start' }), { type: 'summary_progress', chars: 40_000 }), 'cancelled', 10)
  check('a cancelled fold keeps the bar where it stood', foldBarText(foldBarCells(cancelled)) === '█████░░░░', foldBarText(foldBarCells(cancelled)))
  const failedEarly = foldStatusExit(foldStatusOnEvent(beginFoldStatus({ trigger: 'manual', startedAtMs: 0, sessionMemory: false, microcompaction: true }), { type: 'compact_start' }), 'failed', 10)
  check('a failed fold\'s unmeasured segment stops pulsing', foldBarText(foldBarCells(failedEarly)) === '███░░░░░░', foldBarText(foldBarCells(failedEarly)))
}

console.log('\nS4 the words')
{
  let s = beginFoldStatus({ trigger: 'manual', startedAtMs: 10_000, sessionMemory: false, microcompaction: true })
  check('before a stage word: the head, the bar and the clock', foldRowWords(s, 10_500).line === 'compacting context · ◐░░░░░░░░ · 0s', foldRowWords(s, 10_500).line)
  s = foldStatusOnEvent(foldStatusOnEvent(s, { type: 'stage', stage: 'micro-compaction' }), { type: 'compact_start' })
  s = foldStatusOnEvent(s, { type: 'summary_progress', chars: 4800 })
  const words = foldRowWords(s, 22_400)
  check('summarising: the stage, the streamed tokens, the bar, the elapsed', words.line === 'compacting context · summarising · ↓ 1.2k tokens · ███◐░░░░░ · 12s', words.line)
  check('the elapsed counts from the fold\'s own first act', words.elapsed === '12s')
  const retry = foldRowWords(foldStatusOnEvent(s, { type: 'retry', attempt: 2 }), 22_400)
  check('a narrowing retry is named on the row', retry.stage === 'summarising · retry 2', retry.stage ?? 'null')
  const auto = foldRowWords(beginFoldStatus({ trigger: 'auto', startedAtMs: 0, sessionMemory: false, microcompaction: false }), 0)
  check('the automatic fold says so in the head', auto.head === 'compacting context (auto)')
  const landed = foldRowWords(foldStatusExit(s, 'landed', 18_200), 99_000)
  check('a landed fold reads compacted, its clock stopped at the exit', landed.line === 'compacting context · compacted · █████████ · 8s', landed.line)
  const cancelled = foldRowWords(foldStatusExit(s, 'cancelled', 13_100), 99_000)
  check('a cancelled fold says cancelled and keeps no token clause', cancelled.stage === 'cancelled' && cancelled.tokens === null && cancelled.elapsed === '3s', cancelled.line)
  const failed = foldRowWords(foldStatusExit(s, 'failed', 13_100), 99_000)
  check('a failed fold says failed', failed.stage === 'failed')
  const restoring = foldRowWords(foldStatusOnEvent(s, { type: 'stage', stage: 'restoring' }), 22_400)
  check('off the summarising stage the token clause is gone', restoring.tokens === null && restoring.stage === 'restoring')
}

console.log('\nS5 the decode refuses what it does not know')
{
  const s = foldStatusOnEvent(foldStatusOnEvent(beginFoldStatus({ trigger: 'manual', startedAtMs: 5, sessionMemory: true, microcompaction: true }), { type: 'compact_start' }), { type: 'summary_progress', chars: 400 })
  const back = decodeFoldStatus(JSON.parse(JSON.stringify(s)))
  check('a record round-trips through the wire', JSON.stringify(back) === JSON.stringify(s))
  const exited = foldStatusExit(s, 'failed', 9)
  check('an exited record round-trips', JSON.stringify(decodeFoldStatus(JSON.parse(JSON.stringify(exited)))) === JSON.stringify(exited))
  check('the bare word is no record', decodeFoldStatus('compacting') === null)
  check('a foreign stage word refuses the record', decodeFoldStatus({ ...s, stages: ['warming', 'summarising'] }) === null)
  check('a stage outside the list refuses the record', decodeFoldStatus({ ...s, stage: 'restoring', stages: ['summarising'] }) === null)
  check('a missing schema refuses the record', decodeFoldStatus({ ...s, schema: 2 }) === null)
  check('an unknown exit refuses the record', decodeFoldStatus({ ...s, exit: 'vanished' }) === null)
  const clamped = decodeFoldStatus({ ...s, fill: 7 })
  check('an out-of-range fill clamps', clamped !== null && clamped.fill === 1)
  check('null and a number are no record', decodeFoldStatus(null) === null && decodeFoldStatus(3) === null)
}

console.log('\nS6 the one-row visibility law')
{
  const live = beginFoldStatus({ trigger: 'manual', startedAtMs: 0, sessionMemory: false, microcompaction: true })
  const now = 1000
  check('a live manual fold this screen sent paints while its send is unlanded', foldRowVisible(live, { sentHere: true, sendUnlanded: true, nowMs: now }))
  check('…and hides the moment the send landed (the card paints there)', !foldRowVisible(live, { sentHere: true, sendUnlanded: false, nowMs: now }))
  check('a live manual fold another screen sent paints', foldRowVisible(live, { sentHere: false, sendUnlanded: false, nowMs: now }))
  const auto = beginFoldStatus({ trigger: 'auto', startedAtMs: 0, sessionMemory: false, microcompaction: false })
  check('a live automatic fold paints', foldRowVisible(auto, { sentHere: false, sendUnlanded: false, nowMs: now }))
  const exited = foldStatusExit(live, 'landed', 1000)
  check('an exited fold stands while its send is unlanded, within the linger', foldRowVisible(exited, { sentHere: true, sendUnlanded: true, nowMs: 1000 + FOLD_EXIT_LINGER_MS - 1 }))
  check('…and not past the linger', !foldRowVisible(exited, { sentHere: true, sendUnlanded: true, nowMs: 1000 + FOLD_EXIT_LINGER_MS }))
  check('an exited fold hides once the send landed', !foldRowVisible(exited, { sentHere: true, sendUnlanded: false, nowMs: 1001 }))
  check('no record, no row', !foldRowVisible(null, { sentHere: true, sendUnlanded: true, nowMs: now }))
}

console.log('\nS7 withFoldStatus owns the stamps')
{
  type Stamp = unknown
  const drive = async (trigger: 'manual' | 'auto', work: (scoped: { onCompactProgress?: (e: unknown) => void; setResponseLength?: (u: (p: number) => number) => void; setSDKStatus?: (w: unknown) => void }) => Promise<string>): Promise<{ stamps: Stamp[]; out: string | null; error: unknown }> => {
    const stamps: Stamp[] = []
    const context = { setSDKStatus: (word: unknown) => stamps.push(word), abortController: new AbortController() } as never
    let out: string | null = null
    let error: unknown = null
    try {
      out = await withFoldStatus(context, work as never, { trigger, sessionMemory: false, microcompaction: trigger === 'manual' })
    } catch (e) {
      error = e
    }
    return { stamps, out, error }
  }
  const compacting = (stamp: Stamp): Record<string, unknown> | null =>
    stamp !== null && typeof stamp === 'object' && 'compacting' in (stamp as object) ? ((stamp as { compacting: Record<string, unknown> }).compacting ?? null) : null

  const landed = await drive('manual', async scoped => {
    scoped.onCompactProgress?.({ type: 'stage', stage: 'micro-compaction' })
    scoped.setSDKStatus?.('compacting')
    scoped.onCompactProgress?.({ type: 'compact_start' })
    scoped.setResponseLength?.(() => 0)
    for (let i = 0; i < 20; i++) scoped.setResponseLength?.(prev => prev + 200)
    scoped.setSDKStatus?.(null)
    await sleep(FOLD_STAMP_THROTTLE_MS + 60)
    scoped.onCompactProgress?.({ type: 'stage', stage: 'restoring' })
    return 'folded'
  })
  check('the work\'s answer rides through', landed.out === 'folded' && landed.error === null)
  const first = compacting(landed.stamps[0])
  check('the first stamp is the record, before any stage word (the prelude is covered)', first !== null && first.stage === null && first.trigger === 'manual', JSON.stringify(landed.stamps[0]))
  const stages = landed.stamps.map(s => compacting(s)?.stage ?? (s === null ? 'null' : String(s)))
  check('stage flips stamp at once and in order', stages.indexOf('micro-compaction') === 1 && stages.indexOf('summarising') > 1 && stages.indexOf('restoring') > stages.indexOf('summarising'), stages.join(' → '))
  const fillStamps = landed.stamps.filter(s => compacting(s)?.stage === 'summarising')
  check('twenty fill deltas ride a short cadence, not twenty stamps', fillStamps.length >= 2 && fillStamps.length <= 4, `${fillStamps.length} summarising stamps`)
  const last = compacting(landed.stamps[landed.stamps.length - 1])
  check('the one finally stamps the landed exit for a manual fold', last !== null && last.exit === 'landed' && typeof last.endedAtMs === 'number', JSON.stringify(landed.stamps[landed.stamps.length - 1]))
  check('the inner pair\'s null never reaches the wire mid-fold', !landed.stamps.some(s => s === null))
  const reStamp = landed.stamps.filter(s => compacting(s)?.stage === 'micro-compaction')
  check("the inner pair's word re-stamps the record (two micro-compaction stamps: the flip and the word)", reStamp.length === 2, `${reStamp.length}`)
  const fillTokens = fillStamps.map(s => Number(compacting(s)?.summaryTokens ?? -1))
  check('the streamed tokens reach the record', fillTokens[fillTokens.length - 1] === 1000, fillTokens.join(','))

  const cancelled = await drive('manual', async () => {
    throw new Error(ERROR_MESSAGE_USER_ABORT)
  })
  const cancelLast = compacting(cancelled.stamps[cancelled.stamps.length - 1])
  check('a thrown cancel stamps the cancelled exit and rethrows', cancelled.error instanceof Error && cancelled.error.message === ERROR_MESSAGE_USER_ABORT && cancelLast?.exit === 'cancelled')
  const failed = await drive('manual', async () => {
    throw new Error('the wire refused')
  })
  const failLast = compacting(failed.stamps[failed.stamps.length - 1])
  check('any other throw stamps the failed exit and rethrows', failed.error instanceof Error && failLast?.exit === 'failed')
  const auto = await drive('auto', async scoped => {
    scoped.onCompactProgress?.({ type: 'compact_start' })
    return 'auto-folded'
  })
  check('the automatic fold\'s finally stamps null (the turn goes on)', auto.out === 'auto-folded' && auto.stamps[auto.stamps.length - 1] === null && compacting(auto.stamps[0])?.trigger === 'auto')
  const bare = await withFoldStatus({} as never, async () => 'no status door', { trigger: 'manual', sessionMemory: false, microcompaction: true })
  check('a context with no status door folds unstamped and unharmed', bare === 'no status door')
}

console.log(failures === 0 ? '\n ✅ FOLD STATUS — one owner, an honest bar, one row' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

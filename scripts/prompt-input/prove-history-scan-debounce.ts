#!/usr/bin/env bun
// ============================================================================
//  scripts/prompt-input/prove-history-scan-debounce.ts — the reverse history
//  search coalesces keystrokes to ONE full-history scan per frame, and
//  Enter stays immediate.
//
//  Each typed character used to close the reader and re-scan the FULL
//  on-disk history from byte zero (makeHistoryReader re-reads + re-parses
//  the records file per scan). The scan now rides a one-frame debounce
//  built on the same armed-timer census idiom the typeahead landed. Laws:
//
//   D1  (counted operations) a burst of keystrokes inside one frame runs
//       the scan ONCE — the hook's exact disarm-then-arm pattern driven
//       10x within a tick fires the callback exactly once, and the census
//       returns to zero (no timer outlives its window);
//   D2  census discipline — disarm before fire leaves zero and never runs;
//       distinct windows each run once;
//   D3  (source pins — Enter immediate, the identity fixed synchronously)
//       accept/execute act through withFixedMatch, whose own block holds
//       no await, no timer arm, no setTimeout: the settled match when the
//       query's scan has landed, else the timer is disarmed, the scan
//       aborted and the loaded corpus walked in place; only a paste-bearing
//       record's resolution is awaited, after the record is fixed; the
//       empty-query restore is immediate; nextMatch FLUSHES a pending scan
//       as a fresh scan; reset and handleStartSearch disarm; the non-empty
//       keystroke path arms with HISTORY_SCAN_DEBOUNCE_MS and reads the
//       query at fire time; the scan raises its in-flight flag before its
//       async road and lowers it in a finally guarded by its epoch.
//   G   (the fast-Enter arm, module drive) THE DEFECT: "foo" settled, "b"
//       typed inside the window, Enter — the previous query's match used to
//       EXECUTE. The identity fixed over the loaded corpus is the NEW
//       query's first match; a continuing scan's seen set yields the next
//       not-yet-seen match; no match is no match; a record without pastes
//       resolves before the call returns; a paste-bearing record resolves
//       through the corpus reader after the fix; the disarmed timer never
//       fires.
//
//  Pure module + source pins — no PTY, no render.
//
//  Run: ~/.bun/bin/bun run scripts/prompt-input/prove-history-scan-debounce.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const hooks = await import('../../src/hooks/useHistorySearch.ts')
const { armHistoryScanTimer, disarmHistoryScanTimer, historyScanTimerCensus, HISTORY_SCAN_DEBOUNCE_MS } = hooks

section('D1 · a keystroke burst coalesces to ONE scan')
{
  let runs = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // The hook's exact per-keystroke pattern: disarm the pending scan, arm
  // the next — ten keystrokes inside one tick.
  for (let i = 0; i < 10; i++) {
    disarmHistoryScanTimer(timer)
    timer = armHistoryScanTimer(() => {
      timer = null
      runs++
    }, HISTORY_SCAN_DEBOUNCE_MS)
  }
  check('mid-burst: at most one timer is live', historyScanTimerCensus() === 1, `census=${historyScanTimerCensus()}`)
  await sleep(HISTORY_SCAN_DEBOUNCE_MS * 3)
  check('the burst ran the scan exactly ONCE (the previous shape ran 10)', runs === 1, `runs=${runs}`)
  check('census back to zero after the window', historyScanTimerCensus() === 0, `census=${historyScanTimerCensus()}`)
}

section('D2 · census discipline')
{
  let ran = 0
  const t = armHistoryScanTimer(() => {
    ran++
  }, HISTORY_SCAN_DEBOUNCE_MS)
  disarmHistoryScanTimer(t)
  await sleep(HISTORY_SCAN_DEBOUNCE_MS * 2)
  check('a disarmed timer never runs and leaves the census at zero', ran === 0 && historyScanTimerCensus() === 0, `ran=${ran} census=${historyScanTimerCensus()}`)
  let windows = 0
  const t2 = armHistoryScanTimer(() => {
    windows++
  }, 5)
  void t2
  await sleep(20)
  const t3 = armHistoryScanTimer(() => {
    windows++
  }, 5)
  void t3
  await sleep(20)
  check('distinct windows each run once', windows === 2 && historyScanTimerCensus() === 0, `windows=${windows}`)
}

section('D3 · source pins — Enter immediate, flush-on-cycle, disarm on every exit')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/hooks/useHistorySearch.ts'), 'utf8')
  const blockOf = (anchor: string): string => {
    const at = src.indexOf(anchor)
    return at === -1 ? '' : src.slice(at, src.indexOf('\n  }, [', at) + 1)
  }
  const acceptBlock = blockOf('const accept = useCallback')
  const executeBlock = blockOf('const execute = useCallback')
  check('accept acts through withFixedMatch — no debounce arm, no await, no setTimeout in its block', acceptBlock !== '' && /withFixedMatch\(match => \{/.test(acceptBlock) && !/armHistoryScanTimer|await |setTimeout/.test(acceptBlock))
  check('execute acts through withFixedMatch — no debounce arm, no await, no setTimeout in its block', executeBlock !== '' && /withFixedMatch\(match => \{/.test(executeBlock) && !/armHistoryScanTimer|await |setTimeout/.test(executeBlock))
  const fixBlock = src.slice(src.indexOf('const withFixedMatch = useCallback'), src.indexOf('const accept = useCallback'))
  check('withFixedMatch: the settled match stands only when nothing is pending or in flight', /if \(queryRef\.current === '' \|\| \(!pending && !scanInFlightRef\.current\)\) \{\s*\n\s*settle\(matchRef\.current\)/.test(fixBlock))
  check('…else the timer is disarmed, the scan aborted and the identity fixed over the loaded corpus — synchronously (no await in the block)', /disarmHistoryScanTimer\(scanDebounceRef\.current\)[\s\S]{0,200}scanAbortRef\.current\?\.abort\(\)[\s\S]{0,400}findHistoryMatchSync\(corpus, queryRef\.current, seenRef\.current\)/.test(fixBlock) && !/await |setTimeout|\barmHistoryScanTimer/.test(fixBlock))
  check('…with a fresh scan\'s semantics when the timer was pending (the previous query\'s seen set dropped)', /if \(pending\) seenRef\.current\.clear\(\)/.test(fixBlock))
  check('…and the resolution runs only after the record is fixed', /if \(record === undefined\) \{\s*\n\s*settle\(undefined\)\s*\n\s*return\s*\n\s*\}\s*\n\s*resolveFixedMatch\(record, settle\)/.test(fixBlock))
  const resolveBlock = src.slice(src.indexOf('export function resolveFixedMatch('), src.indexOf('export function useHistorySearch('))
  check('resolveFixedMatch: a record without pastes settles in place, synchronously', /length === 0\) \{\s*\n\s*settle\(\{ display: record\.display, pastedContents: \{\} \}\)\s*\n\s*return/.test(resolveBlock))
  check('…and a paste-bearing record resolves through the corpus reader (the one owner), after the fix', /makeHistoryReaderOver\(\[record\]\)\.next\(\)/.test(resolveBlock))
  const scanBlock = src.slice(src.indexOf('const scan = useCallback'), src.indexOf('const restoreOriginal = useCallback'))
  check('the scan raises its in-flight flag with an epoch token before its async road', /scanInFlightRef\.current = true\s*\n\s*const token = \+\+scanEpochRef\.current\s*\n\s*void \(async \(\) => \{/.test(scanBlock))
  check('…and lowers it in a finally, only while it is still the latest scan', /\} finally \{[\s\S]{0,300}if \(token === scanEpochRef\.current\) scanInFlightRef\.current = false/.test(scanBlock))
  check('the loaded corpus is kept beside its promise for the walk', /corpusValueRef\.current = corpus/.test(scanBlock) && /if \(corpusRef\.current === load\) corpusValueRef\.current = corpus/.test(src))
  const setQueryBlock = blockOf('const setHistoryQuery = useCallback')
  check(
    'the non-empty keystroke path arms ONE debounced scan at the named cadence, reading the query at fire time',
    /disarmHistoryScanTimer\(scanDebounceRef\.current\)\s*\n\s*scanDebounceRef\.current = armHistoryScanTimer\(\(\) => \{\s*\n\s*scanDebounceRef\.current = null\s*\n\s*scan\(queryRef\.current, false\)\s*\n\s*\}, HISTORY_SCAN_DEBOUNCE_MS\)/.test(setQueryBlock),
  )
  // The branch itself is the scope. The previous negative look-ahead ran
  // up to 900 characters past the branch's start — far enough to reach the
  // arm below the branch and the deps array's onModeChange — so it failed
  // a SHORTER branch that disarmed correctly: a pin on distance, not on
  // shape. The needle is word-bounded: disarmHistoryScanTimer( contains
  // the bare spelling.
  const branchStart = setQueryBlock.indexOf("if (query === '') {")
  const branchEnd = setQueryBlock.indexOf('// One-frame coalescing')
  const emptyBranch = branchStart !== -1 && branchEnd > branchStart ? setQueryBlock.slice(branchStart, branchEnd) : ''
  check(
    'the empty-query restore is IMMEDIATE (disarms, then restores in the same call — no arm inside the branch)',
    emptyBranch !== '' &&
      /disarmHistoryScanTimer\(scanDebounceRef\.current\)[\s\S]{0,900}onModeChange\(original\.mode\)[\s\S]{0,200}return/.test(emptyBranch) &&
      !/\barmHistoryScanTimer\(/.test(emptyBranch),
  )
  const nextBlock = blockOf('const nextMatch = useCallback')
  check(
    'nextMatch flushes a pending scan as a FRESH scan (never continues a stale reader)',
    /scanDebounceRef\.current !== null[\s\S]{0,400}scan\(queryRef\.current, false\)[\s\S]{0,60}return/.test(nextBlock),
  )
  const resetBlock = blockOf('const reset = useCallback')
  check('reset disarms the pending scan', /disarmHistoryScanTimer\(scanDebounceRef\.current\)/.test(resetBlock))
  const startBlock = blockOf('const handleStartSearch = useCallback')
  check('handleStartSearch disarms the pending scan', /disarmHistoryScanTimer\(scanDebounceRef\.current\)/.test(startBlock))
  check('the cadence is roughly one frame (20-50ms)', HISTORY_SCAN_DEBOUNCE_MS >= 20 && HISTORY_SCAN_DEBOUNCE_MS <= 50, String(HISTORY_SCAN_DEBOUNCE_MS))
}

section('G · the fast-Enter arm — the identity is fixed synchronously over the loaded corpus')
{
  const { findHistoryMatchSync, resolveFixedMatch } = hooks
  type Rec = { display: string; pastedContents: Record<number, { id: number; type: 'text' | 'image'; content?: string; contentHash?: string }>; timestamp: number; project: string }
  const rec = (display: string, pastedContents: Rec['pastedContents'] = {}): Rec => ({ display, pastedContents, timestamp: 1, project: '/p' })
  // Newest-first, as the corpus is: the "foo" query settles on the first
  // row; the "foob" query's first match is the second.
  const corpus = [rec('foo fighters'), rec('foobar'), rec('foob!'), rec('unrelated')] as never
  // G1 — THE DEFECT ARM: "foo" settled on 'foo fighters' (its seen set holds
  // it); "b" typed inside the window arms the timer; Enter.
  {
    const settledForFoo = findHistoryMatchSync(corpus, 'foo', new Set())
    check('G1 fixture: the settled "foo" match is the first row', settledForFoo?.display === 'foo fighters')
    let timer: ReturnType<typeof setTimeout> | null = armHistoryScanTimer(() => {}, HISTORY_SCAN_DEBOUNCE_MS)
    // Enter, inside the window: disarm the pending scan and fix the identity
    // now with a fresh scan's semantics (the previous seen set dropped).
    disarmHistoryScanTimer(timer)
    timer = null
    const fixed = findHistoryMatchSync(corpus, 'foob', new Set())
    check("G1 the fixed identity is the NEW query's first match, not the stale settled one", fixed?.display === 'foobar' && fixed?.display !== settledForFoo?.display, String(fixed?.display))
    check('G1 the pending timer is gone (census 0)', historyScanTimerCensus() === 0, `census=${historyScanTimerCensus()}`)
    await sleep(HISTORY_SCAN_DEBOUNCE_MS * 2)
    check('G1 the disarmed scan never fires', historyScanTimerCensus() === 0)
  }
  // G2 — a continuing scan in flight keeps its seen set: the next not-yet-seen match
  check('G2 with the seen set standing, the next not-yet-seen match is fixed', findHistoryMatchSync(corpus, 'foob', new Set(['foobar']))?.display === 'foob!')
  check('G2 the walk keeps the reader order (newest first)', findHistoryMatchSync(corpus, 'foo', new Set())?.display === 'foo fighters')
  // G3 — no match is no match
  check('G3 no record matches ⇒ undefined (Enter then acts on no match, never a stale one)', findHistoryMatchSync(corpus, 'zzz', new Set()) === undefined)
  check('G3 every match seen ⇒ undefined', findHistoryMatchSync(corpus, 'foob', new Set(['foobar', 'foob!'])) === undefined)
  // G4 — resolution after the fix
  {
    let plain: unknown = 'unset'
    resolveFixedMatch(rec('plain prompt') as never, entry => {
      plain = entry
    })
    const p = plain as { display?: string; pastedContents?: Record<number, unknown> } | 'unset'
    check('G4 a record without pastes settles before the call returns', p !== 'unset' && p?.display === 'plain prompt' && Object.keys(p?.pastedContents ?? { x: 1 }).length === 0, JSON.stringify(plain))
    let pasted: unknown = 'unset'
    resolveFixedMatch(rec('with a paste [Pasted text #1 +2 lines]', { 1: { id: 1, type: 'text', content: 'a\nb\nc' } }) as never, entry => {
      pasted = entry
    })
    check('G4 a paste-bearing record does not settle synchronously (the identity is already fixed)', pasted === 'unset')
    await sleep(30)
    const q = pasted as { display?: string; pastedContents?: Record<number, { content?: string }> } | 'unset'
    check('G4 …and settles with the paste resolved through the corpus reader', q !== 'unset' && q?.pastedContents?.[1]?.content === 'a\nb\nc', JSON.stringify(pasted))
  }
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)

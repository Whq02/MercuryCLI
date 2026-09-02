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
//   D3  (source pins — Enter immediate) accept/execute read the settled
//       match synchronously and never touch the debounce; the empty-query
//       restore is immediate; nextMatch FLUSHES a pending scan as a fresh
//       scan; reset and handleStartSearch disarm; the non-empty keystroke
//       path arms with HISTORY_SCAN_DEBOUNCE_MS and reads the query at
//       fire time.
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
  check('accept reads the settled match synchronously — no debounce interaction, no await', acceptBlock !== '' && !/armHistoryScanTimer|await |setTimeout/.test(acceptBlock))
  check('execute reads the settled match synchronously — no debounce interaction, no await', executeBlock !== '' && !/armHistoryScanTimer|await |setTimeout/.test(executeBlock))
  const setQueryBlock = blockOf('const setHistoryQuery = useCallback')
  check(
    'the non-empty keystroke path arms ONE debounced scan at the named cadence, reading the query at fire time',
    /disarmHistoryScanTimer\(scanDebounceRef\.current\)\s*\n\s*scanDebounceRef\.current = armHistoryScanTimer\(\(\) => \{\s*\n\s*scanDebounceRef\.current = null\s*\n\s*scan\(queryRef\.current, false\)\s*\n\s*\}, HISTORY_SCAN_DEBOUNCE_MS\)/.test(setQueryBlock),
  )
  check(
    'the empty-query restore is IMMEDIATE (disarms, then restores in the same call — no arm before the restore)',
    /if \(query === ''\) \{[\s\S]{0,900}disarmHistoryScanTimer[\s\S]{0,900}onModeChange\(original\.mode\)[\s\S]{0,200}return/.test(setQueryBlock) &&
      !/if \(query === ''\) \{[\s\S]{0,900}armHistoryScanTimer\(\(\) =>[\s\S]{0,300}onModeChange/.test(setQueryBlock),
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

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)

#!/usr/bin/env bun
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

section('D3 · source pins — Enter through the gate, flush-on-cycle, disarm on every exit')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/hooks/useHistorySearch.ts'), 'utf8')
  const blockOf = (anchor: string): string => {
    const at = src.indexOf(anchor)
    return at === -1 ? '' : src.slice(at, src.indexOf('\n  }, [', at) + 1)
  }
  const acceptBlock = blockOf('const accept = useCallback')
  const executeBlock = blockOf('const execute = useCallback')
  check(
    'accept settles through the gate with the fresh-scan flush — no timer arm, no await of its own',
    acceptBlock !== '' && /gate\.settle\(\(\) => \{[\s\S]*\}, flushScan\)/.test(acceptBlock) && !/armHistoryScanTimer|await |setTimeout/.test(acceptBlock),
  )
  check(
    'execute settles through the gate with the fresh-scan flush — no timer arm, no await of its own',
    executeBlock !== '' && /gate\.settle\(\(\) => \{[\s\S]*\}, flushScan\)/.test(executeBlock) && !/armHistoryScanTimer|await |setTimeout/.test(executeBlock),
  )
  check("the flush is the query's own scan, fresh", /const flushScan = useCallback\(\(\): void => \{\s*\n\s*scan\(queryRef\.current, false\)\s*\n\s*\}, \[scan\]\)/.test(src))
  const setQueryBlock = blockOf('const setHistoryQuery = useCallback')
  check(
    'the non-empty keystroke path arms the gate at the named cadence, reading the query at fire time',
    /gate\.arm\(\(\) => scan\(queryRef\.current, false\), HISTORY_SCAN_DEBOUNCE_MS\)/.test(setQueryBlock),
  )
  check(
    'the empty-query restore is IMMEDIATE (disarms the gate, then restores in the same call — no arm before the restore)',
    /if \(query === ''\) \{[\s\S]{0,900}gate\.disarm\(\)[\s\S]{0,900}onModeChange\(original\.mode\)[\s\S]{0,200}return/.test(setQueryBlock) &&
      !/if \(query === ''\) \{[\s\S]{0,900}gate\.arm\([\s\S]{0,300}onModeChange/.test(setQueryBlock),
  )
  const nextBlock = blockOf('const nextMatch = useCallback')
  check(
    'nextMatch flushes a pending scan as a FRESH scan (never continues a stale reader)',
    /gate\.pending\(\)[\s\S]{0,400}gate\.disarm\(\)[\s\S]{0,100}scan\(queryRef\.current, false\)[\s\S]{0,60}return/.test(nextBlock),
  )
  const resetBlock = blockOf('const reset = useCallback')
  check('reset disarms the gate', /gate\.disarm\(\)/.test(resetBlock))
  const startBlock = blockOf('const handleStartSearch = useCallback')
  check('handleStartSearch disarms the gate', /gate\.disarm\(\)/.test(startBlock))
  const scanBlock = src.slice(src.indexOf('const scan = useCallback'), src.indexOf('const restoreOriginal = useCallback'))
  check('the scan reports its start edge to the gate before the async road begins', /const token = gate\.scanStarted\(\)\s*\n\s*void \(async \(\) => \{/.test(scanBlock))
  check('…and its landing in a finally (every road out)', /\} finally \{[\s\S]{0,300}gate\.scanLanded\(token\)/.test(scanBlock))
  check('the gate is the one timer owner in the hook (no bare debounce ref remains)', !src.includes('scanDebounceRef'))
  check('the cadence is roughly one frame (20-50ms)', HISTORY_SCAN_DEBOUNCE_MS >= 20 && HISTORY_SCAN_DEBOUNCE_MS <= 50, String(HISTORY_SCAN_DEBOUNCE_MS))
}

section("G · the scan gate — Enter waits for the query's own scan")
{
  const { createHistoryScanGate } = hooks
  {
    const gate = createHistoryScanGate()
    let scans = 0
    let token = -1
    const startScan = (): void => {
      scans++
      token = gate.scanStarted()
    }
    gate.arm(startScan, HISTORY_SCAN_DEBOUNCE_MS)
    let accepted = 0
    gate.settle(() => {
      accepted++
    }, startScan)
    check('G1 the pending scan is flushed at once — the timer is gone and the fresh scan started', historyScanTimerCensus() === 0 && scans === 1, `census=${historyScanTimerCensus()} scans=${scans}`)
    check("G1 the accept did NOT run on the previous query's match", accepted === 0)
    gate.scanLanded(token)
    check('G1 the accept ran exactly once, after the landing', accepted === 1, String(accepted))
    await sleep(HISTORY_SCAN_DEBOUNCE_MS * 2)
    check('G1 the disarmed timer never fires a second scan', scans === 1 && historyScanTimerCensus() === 0, `scans=${scans}`)
  }
  {
    const gate = createHistoryScanGate()
    const t = gate.scanStarted()
    let accepted = 0
    let flushed = 0
    gate.settle(() => {
      accepted++
    }, () => {
      flushed++
    })
    check('G2 an in-flight scan queues the Enter (no flush, no run yet)', accepted === 0 && flushed === 0)
    gate.scanLanded(t)
    check('G2 …and lands it exactly once', accepted === 1)
  }
  {
    const gate = createHistoryScanGate()
    let accepted = 0
    let flushed = 0
    gate.settle(() => {
      accepted++
    }, () => {
      flushed++
    })
    check('G3 with nothing pending Enter runs at once, no flush', accepted === 1 && flushed === 0)
  }
  {
    const gate = createHistoryScanGate()
    const t1 = gate.scanStarted()
    let accepted = 0
    gate.settle(() => {
      accepted++
    }, () => {})
    const t2 = gate.scanStarted()
    gate.scanLanded(t1)
    check("G4 the superseded scan's landing runs nothing", accepted === 0)
    gate.scanLanded(t2)
    check("G4 the latest scan's landing runs the Enter once", accepted === 1)
    gate.scanLanded(t2)
    check('G4 a repeated landing never re-runs it', accepted === 1)
  }
  {
    const gate = createHistoryScanGate()
    const t = gate.scanStarted()
    let accepted = 0
    let scans = 0
    gate.settle(() => {
      accepted++
    }, () => {})
    gate.arm(() => {
      scans++
    }, 5)
    gate.scanLanded(t)
    check('G5 the keystroke dropped the queued Enter', accepted === 0)
    await sleep(25)
    check("G5 the keystroke's own scan fired once and the census is zero", scans === 1 && historyScanTimerCensus() === 0, `scans=${scans}`)
  }
  {
    const gate = createHistoryScanGate()
    let scans = 0
    let token = -1
    const startScan = (): void => {
      scans++
      token = gate.scanStarted()
    }
    gate.arm(startScan, HISTORY_SCAN_DEBOUNCE_MS)
    check('G6 pending() reports the armed timer', gate.pending())
    let accepted = 0
    gate.settle(() => {
      accepted++
    }, startScan)
    gate.disarm()
    gate.scanLanded(token)
    check('G6 disarm dropped the queued Enter; the census is zero and nothing is pending', accepted === 0 && historyScanTimerCensus() === 0 && !gate.pending())
    await sleep(HISTORY_SCAN_DEBOUNCE_MS * 2)
    check('G6 nothing fires later', scans === 1, `scans=${scans}`)
  }
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)

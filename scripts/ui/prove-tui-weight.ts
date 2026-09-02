#!/usr/bin/env bun
// ============================================================================
//  prove-tui-weight — the heavy/jumpy-feel sources are closed (5.6 Sol audit
// revalidated at HEAD; slice B landed the WorkCapsule/
//  spinner-footprint/berth-slot/modal-mount halves — this proof pins the
//  REMAINING halves shipped here):
//
//   1. FullscreenLayout's TerminalSizeContext value is MEMOIZED — identical
//      geometry keeps object identity; a real resize publishes a new value.
//   2. StreamBatcher has a SILENT path: an input_json_delta storm schedules
//      zero sinks; content_block_stop commits the finished input; empty→empty
//      resets never commit.
//   3. REPL / PromptInput / Spinner task subscriptions are NARROW — an
//      unrelated background agent's progress tick re-renders none of them.
//   4. The live tail turn receipt keys off its TURN BOUNDARY, not the latest
//      appended message (no per-message remounts).
//   5. Short-wide cockpit heights SHED tail telemetry sections and publish
//      only rendered selectable rows (the cursor can't reach off-screen rows).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, '../../', ...p), 'utf8')

console.log('============================================================')
console.log(' TUI weight/jump sources — proof')
console.log('============================================================')

// ── 1. TerminalSizeContext identity ──────────────────────────────────────────
{
  const fsl = src('src', 'components', 'FullscreenLayout.tsx')
  check(
    'FullscreenLayout memoizes the size override (top-level hook)',
    /const sizeVal = useMemo\(\(\) => \{\s*const next = cockpit/.test(fsl),
  )
  check(
    'the fullscreen branch consumes the memo (no per-render object)',
    /TerminalSizeContext\.Provider value=\{sizeVal\}/.test(fsl) &&
      !/const sizeVal = cockpit\s*\?/.test(fsl),
  )
  const wc = src('src', 'components', 'mercury-ui', 'WorkCapsule.tsx')
  check('WorkCapsule size override stays memoized (slice B hold)', /const sizeVal = React\.useMemo\(/.test(wc))
}

// ── 2. StreamBatcher silent path (behavioral) ───────────────────────────────
{
  const { StreamBatcher } = await import('../../src/utils/messages/streamBatcher.ts')
  type Item = { index: number; unparsedToolInput: string }
  let sinks = 0
  const timers: Array<() => void> = []
  const b = new StreamBatcher<Item[]>([], {
    sink: () => {
      sinks++
    },
    flushNow: (prev, next) => prev.length !== next.length,
    setTimer: fn => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
  })
  // block start: a new tool_use row — immediate flush (length change).
  b.update(cur => [...cur, { index: 0, unparsedToolInput: '' }])
  check('block start commits immediately', sinks === 1)
  // 100-delta storm — SILENT: no sink, no timer.
  for (let i = 0; i < 100; i++) {
    b.updateSilent(cur => {
      const next = cur.slice()
      next[0] = { ...next[0]!, unparsedToolInput: next[0]!.unparsedToolInput + 'x' }
      return next
    })
  }
  check('100-delta storm schedules ZERO sinks', sinks === 1, `sinks=${sinks}`)
  check('100-delta storm arms ZERO timers', timers.length === 0, `timers=${timers.length}`)
  check('the accumulated input stays ref-fresh', b.current[0]!.unparsedToolInput.length === 100)
  // content_block_stop: the finished input commits (before its result could).
  b.flushSilent()
  check('content_block_stop commits the finished input', sinks === 2)
  b.flushSilent()
  check('a text-block stop (nothing silent-dirty) commits nothing', sinks === 2)
  // identity update — still free.
  b.updateSilent(cur => cur)
  b.flushSilent()
  check('identity silent update never dirties', sinks === 2)
}
{
  const streaming = src('src', 'utils', 'messages', 'streaming.ts')
  check(
    'input_json_delta routes through the silent path',
    /case 'input_json_delta'[\s\S]{0,1600}\{ silent: true \}/.test(streaming),
  )
  check(
    'content_block_stop flushes the silent accumulation',
    /case 'content_block_stop':[\s\S]{0,400}\{ flushSilent: true \}/.test(streaming),
  )
  check(
    'message_stop clear is identity when already empty',
    streaming.includes('current.length === 0 ? current : []'),
  )
  // The stream's home is the session's runner (its stream frames become the
  // seat's live tail); the face holds no batcher and no tool-use reset — the
  // per-delta weight it once carried is gone with the engine.
  const repl = src('src', 'screens', 'REPL.tsx')
  check(
    'the face holds no stream batcher (the runner streams; the seat tail carries it)',
    !repl.includes('batcher.') && !repl.includes('streamingToolUsesBatcher'),
  )
  check(
    'the face holds no turn-boundary tool-use reset (no per-delta commit path to skip)',
    !repl.includes('resetStreamingToolUses'),
  )
}

// ── 3. narrow task subscriptions ─────────────────────────────────────────────
{
  // A session's tasks and teammates live in its runner: the face subscribes
  // to no task map at all (the agent view on the face is a named follow-up).
  const repl = src('src', 'screens', 'REPL.tsx')
  check(
    'REPL holds no task-map subscription (no viewed-task read, no whole-map read)',
    !repl.includes('viewingAgentTaskId') && !/const tasks = useAppState\((state|s) => (state|s)\.tasks\)/.test(repl),
  )
  check(
    'REPL derives no teammate-running truth of its own (the runner owns its teammates)',
    !repl.includes('getRunningTeammatesSorted') && !repl.includes('anyTaskRunning'),
  )
  const spinner = src('src', 'components', 'Spinner.tsx')
  check(
    'Spinner subscribes to primitives + the viewed teammate object only',
    !/useAppState\(state => state\.tasks\)/.test(spinner) &&
      !/useAppState\(state => state\)/.test(spinner) &&
      /const foregroundedTeammate = useAppState\(state =>\s*getViewedTeammateTask\(state\),?\s*\)/.test(spinner) &&
      /const runningTeammateCount = useAppState\(state =>/.test(spinner),
  )
  const pi = src('src', 'components', 'PromptInput', 'PromptInput.tsx')
  // There is no getVisibleAgentTasks event-time read and no hosted
  // remote-session rail — the law
  // (primitive subscriptions; store reads at event time) rides the
  // teammate-footer reads.
  check(
    'PromptInput subscribes to primitives; handlers read the store at event time',
    !/const tasks = useAppState\(\(s: AppState\) => s\.tasks\)/.test(pi) &&
      /const viewedTask = useAppState\(\(s: AppState\) =>\s*s\.viewingAgentTaskId !== undefined \? s\.tasks\[s\.viewingAgentTaskId\] : undefined,?\s*\)/.test(pi) &&
      pi.includes('fresh.tasks'),
  )
}

// ── 4. turn receipt identity ─────────────────────────────────────────────────
{
  const { injectTurnReceipts } = await import('../../src/utils/cockpit/turnReceipt.ts')
  process.env.MERCURY_TURN_RECEIPT = '1'
  const boundary = (uuid: string, text: string) => ({
    type: 'user',
    uuid,
    message: { content: [{ type: 'text', text }] },
  })
  const toolUse = (uuid: string) => ({
    type: 'assistant',
    uuid,
    // 'Read' counts at the tool_use row (Edits count from RESULT rows).
    message: { content: [{ type: 'tool_use', name: 'Read', id: `t-${uuid}`, input: {} }] },
  })
  const base = [boundary('u1', 'do the thing'), toolUse('a1')]
  const withMore = [...base, toolUse('a2'), toolUse('a3')]
  const r1 = injectTurnReceipts(base as never) as Array<{ type: string; uuid: string }>
  const r2 = injectTurnReceipts(withMore as never) as Array<{ type: string; uuid: string }>
  const tail1 = r1.find(m => m.type === 'turn_receipt')
  const tail2 = r2.find(m => m.type === 'turn_receipt')
  check(
    'live tail receipt keeps ONE identity as messages append',
    tail1 !== undefined && tail2 !== undefined && tail1.uuid === tail2.uuid,
    `${tail1?.uuid} vs ${tail2?.uuid}`,
  )
  check('the identity derives from the turn boundary', tail1?.uuid === 'u1-turn-receipt')
  const twoTurns = [
    boundary('u1', 'first'),
    toolUse('a1'),
    boundary('u2', 'second'),
    toolUse('b1'),
  ]
  const r3 = injectTurnReceipts(twoTurns as never) as Array<{ type: string; uuid: string }>
  const receipts = r3.filter(m => m.type === 'turn_receipt').map(m => m.uuid)
  check(
    'each turn owns its receipt identity',
    receipts.length === 2 && receipts[0] === 'u1-turn-receipt' && receipts[1] === 'u2-turn-receipt',
    receipts.join(', '),
  )
  delete process.env.MERCURY_TURN_RECEIPT
}

// ── 5. short-height rail shedding ────────────────────────────────────────────
{
  const rail = src('src', 'components', 'HelmTelemetryRail.tsx')
  check(
    'sections shed in reverse priority against the measured ceiling',
    rail.includes('const shedCeiling = availRows ?? termRows - 7') &&
      rail.includes('const healthShed = !fitsSection(healthRowsIntended)') &&
      rail.includes('const traceShed = !fitsSection(traceRowsIntended)') &&
      rail.includes('const consoleShed = consoleOn && !fitsSection(1)'),
  )
  check(
    'the panel chrome height is honest (border + header + border = 3)',
    rail.includes('const RAIL_PANEL_CHROME = 3'),
  )
  check(
    'a shed section registers NO selectable rows (builders gated)',
    rail.includes('healthShed ? [] : [') &&
      /const traceNodes: React\.ReactNode\[\] = \[\]\s*\n\s*if \(!traceShed\)/.test(rail) &&
      /consoleShed/.test(rail),
  )
  check(
    'everything shed folds into ONE honest pointer line, fit-gated',
    rail.includes('short height — ${shedPointers.join') &&
      rail.includes('shedPointers.length > 0 && shedPointerFits') &&
      // /doctor became /health — the shed pointer names the
      // command that actually reopens the section.
      rail.includes("...(healthShed ? ['/health'] : [])") &&
      rail.includes("...(consoleShed ? ['/console'] : [])"),
  )
  check(
    'the published row model is built ONLY from rendered rows (sel() inside the gates)',
    rail.includes("publishHelmRows('telemetry', rowsModel)"),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} TUI-WEIGHT CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TUI-WEIGHT PROOFS PASS')

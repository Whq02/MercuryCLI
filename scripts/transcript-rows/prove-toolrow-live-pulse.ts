#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-toolrow-live-pulse.ts
//  PROOF: LAYER 1 of the live-progress design (LIVEPAINT) — the running
//  tool's row WEARS THE PULSE from the screen's existing knowledge, and the
//  settle stops it. No new wire is involved: the chain is
//
//    records fold (liveTurnStateOf → inProgressToolUseIDs)     [driven §A]
//      → the row derivation (running = inProgress && !resolved,
//        shouldAnimate rides it)                               [driven §B]
//      → ToolUseLoader's breath (the ◐-family work glyph while
//        running; the fixed state mark at settle)              [driven §B]
//    with the daemon-hosted feed seams source-locked            [§C]
//
//  ONLY the glyph cell animates (the breath is a color lerp + the quarter-
//  moon rotation inside one width-2 cell — prove-live-glyphs pins the
//  schedule; prove-transcript-calm-identity pins the identity chain around
//  it). This prover pins the STATE LAW: running wears the work glyph,
//  settle wears the state mark, errors never pulse, and the fold that
//  feeds the set flips exactly at the tool_result.
//
//  Run:  ~/.bun/bin/bun run scripts/transcript-rows/prove-toolrow-live-pulse.ts
// ============================================================================

import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sandbox before src imports (token/theme reads resolve the config home).
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolrow-pulse-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { AssistantToolUseMessage } = await import(
  '../../src/components/messages/AssistantToolUseMessage.js'
)
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')
const { liveTurnStateOf } = await import('../../src/utils/conversationRecovery.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { WORK_FRAMES } = await import('../../src/utils/cockpit/liveGlyphs.js')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.js')
const { BLACK_CIRCLE } = await import('../../src/constants/figures.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── the records the fold reads (hand-built, the transcript file's shapes) ──
const TOOL_ID = 'toolu_pulse_01'
const OTHER_ID = 'toolu_pulse_02'
type RawMsg = Record<string, unknown>
const prompt = (at: number): RawMsg => ({
  type: 'user',
  uuid: `u-${at}`,
  timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: 'run the build' },
})
const toolUse = (at: number, ids: string[]): RawMsg => ({
  type: 'assistant',
  uuid: `a-${at}`,
  timestamp: new Date(at).toISOString(),
  message: {
    role: 'assistant',
    content: ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'bun run build.ts' } })),
  },
})
const toolResult = (at: number, id: string): RawMsg => ({
  type: 'user',
  uuid: `r-${at}`,
  timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

section('§A the pulse FEED — liveTurnStateOf flips exactly at the tool_result')
const runningFold = liveTurnStateOf([prompt(1000), toolUse(2000, [TOOL_ID])] as never)
check(
  'an unresolved tool_use puts ITS id in the in-progress set (the pulse feed)',
  runningFold.inProgressToolUseIDs.has(TOOL_ID) && runningFold.inProgressToolUseIDs.size === 1,
)
check('…and the phase reads tool / in flight', runningFold.inFlight && runningFold.phase === 'tool')
const settledFold = liveTurnStateOf(
  [prompt(1000), toolUse(2000, [TOOL_ID]), toolResult(3000, TOOL_ID)] as never,
)
check(
  'the tool_result empties the set — THE SETTLE STOPS THE PULSE',
  settledFold.inProgressToolUseIDs.size === 0,
)
const partialFold = liveTurnStateOf(
  [prompt(1000), toolUse(2000, [TOOL_ID, OTHER_ID]), toolResult(3000, OTHER_ID)] as never,
)
check(
  'with two tools and one result, exactly the unresolved one still pulses',
  partialFold.inProgressToolUseIDs.has(TOOL_ID) && !partialFold.inProgressToolUseIDs.has(OTHER_ID),
)

section('§B the pulse WEAR — the row driven through the fold\'s own set')
const baseLookups = (over: Partial<Record<string, unknown>> = {}): unknown => ({
  siblingToolUseIDs: new Map(),
  progressMessagesByToolUseID: new Map(),
  inProgressHookCounts: new Map(),
  resolvedHookCounts: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
  normalizedMessageCount: 1,
  resolvedToolUseIDs: new Set<string>(),
  erroredToolUseIDs: new Set<string>(),
  deniedToolUseIDs: new Set<string>(),
  ...over,
})
async function renderRow(opts: {
  tool: unknown
  name: string
  input: Record<string, unknown>
  inProgress: Set<string>
  lookups: unknown
}): Promise<string> {
  // The provider wrap: the loader's settings read is provider-backed in the
  // product (the REPL wraps every row); the harness mounts the same way.
  const node = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(AssistantToolUseMessage as never, {
      param: { type: 'tool_use', id: TOOL_ID, name: opts.name, input: opts.input },
      tools: [opts.tool],
      verbose: false,
      inProgressToolUseIDs: opts.inProgress,
      shouldAnimate: true,
      shouldShowDot: true,
      lookups: opts.lookups as never,
    } as never),
  )
  return renderToString(node as never, 100)
}
const workFamily = (s: string): boolean => WORK_FRAMES.some(f => s.includes(f))

// RUNNING: driven by the FOLD's own set (chain integrity — the set the
// records produced is the set the row wears the pulse from).
const runningRow = await renderRow({
  tool: BashTool,
  name: 'Bash',
  input: { command: 'bun run build.ts' },
  inProgress: runningFold.inProgressToolUseIDs,
  lookups: baseLookups(),
})
check(
  'the RUNNING row wears the work glyph (the ◐ family — the breathing cell)',
  workFamily(runningRow),
  JSON.stringify(runningRow),
)
check(
  '…and shows the live progress body under the header (running…)',
  runningRow.includes('running…'),
  JSON.stringify(runningRow),
)
check('…and never wears a settle mark while running', !runningRow.includes(BLACK_CIRCLE) && !runningRow.includes(GLYPH.warn))

// SETTLED OK: the fold's post-result set drives the same row — the pulse is
// gone, the fixed done-dot stands, the progress body is gone.
const settledRow = await renderRow({
  tool: BashTool,
  name: 'Bash',
  input: { command: 'bun run build.ts' },
  inProgress: settledFold.inProgressToolUseIDs,
  lookups: baseLookups({ resolvedToolUseIDs: new Set([TOOL_ID]) }),
})
check(
  'the SETTLED row wears the fixed done-dot — the pulse stopped',
  settledRow.includes(BLACK_CIRCLE) && !workFamily(settledRow),
  JSON.stringify(settledRow),
)
check('…and the progress body is gone at settle', !settledRow.includes('running…'))

// ERRORED (non-denied): the warn lead — errors never pulse.
const erroredRow = await renderRow({
  tool: BashTool,
  name: 'Bash',
  input: { command: 'bun run build.ts' },
  inProgress: new Set<string>(),
  lookups: baseLookups({
    resolvedToolUseIDs: new Set([TOOL_ID]),
    erroredToolUseIDs: new Set([TOOL_ID]),
  }),
})
check(
  'an ERRORED row wears the warn lead, never the pulse',
  erroredRow.includes(GLYPH.warn) && !workFamily(erroredRow),
  JSON.stringify(erroredRow),
)

// DENIED: the crimson ✕ — the operator said no.
const deniedRow = await renderRow({
  tool: BashTool,
  name: 'Bash',
  input: { command: 'bun run build.ts' },
  inProgress: new Set<string>(),
  lookups: baseLookups({
    resolvedToolUseIDs: new Set([TOOL_ID]),
    erroredToolUseIDs: new Set([TOOL_ID]),
    deniedToolUseIDs: new Set([TOOL_ID]),
  }),
})
check('a DENIED row wears the ✕ lead', deniedRow.includes(GLYPH.fail) && !workFamily(deniedRow))

// A RESOLVED READ: the non-mutating ◌ ring (the settle family's read fork).
const readRow = await renderRow({
  tool: FileReadTool,
  name: 'Read',
  input: { file_path: '/scratch/notes.md' },
  inProgress: new Set<string>(),
  lookups: baseLookups({ resolvedToolUseIDs: new Set([TOOL_ID]) }),
})
check('a resolved READ wears the ◌ scanned ring', readRow.includes(GLYPH.read) && !workFamily(readRow))

section('§C the daemon-hosted feed seams (source locks, call-shaped)')
{
  const root = join(import.meta.dir, '../../src')
  const loader = readFileSync(join(root, 'components/ToolUseLoader.tsx'), 'utf8')
  check(
    'ToolUseLoader breathes only while unresolved+animating (the gate line)',
    loader.includes('isUnresolved && !isError && shouldAnimate && !reducedMotion && focused'),
  )
  check(
    'the work rotation rides the breath clock in ONE place (the running branch)',
    (loader.match(/workGlyphForTime\(/g) ?? []).length === 1,
  )
  const row = readFileSync(join(root, 'components/messages/AssistantToolUseMessage.tsx'), 'utf8')
  check(
    'the row animates exactly while running (shouldAnimate && running)',
    row.includes('shouldAnimate={shouldAnimate && running}') &&
      row.includes('const running = inProgress && !resolved'),
  )
  const messageRow = readFileSync(join(root, 'components/MessageRow.tsx'), 'utf8')
  check(
    "MessageRow's animation permission derives from the in-progress set",
    messageRow.includes('inProgressToolUseIDs.has(toolUseID))'),
  )
  const repl = readFileSync(join(root, 'screens/REPL.tsx'), 'utf8')
  check(
    "the REPL's view set is the CONNECTOR's live set (the daemon-hosted feed)",
    repl.includes('const viewInProgressToolUseIDs = seatLive.inProgressToolUseIDs;'),
  )
  const connector = readFileSync(join(root, 'services/engine-connector/daemonConnector.ts'), 'utf8')
  check(
    "the connector folds its live set from ITS OWN records (liveTurnStateOf)",
    connector.includes('this.liveFold.fold(this.rawRecords, chain.since)'),
  )
}

console.log(
  failures === 0
    ? '\n✅ TOOLROW LIVE-PULSE LAW HOLDS (running wears it, settle stops it)'
    : `\n❌ ${failures} TOOLROW LIVE-PULSE CHECK(S) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

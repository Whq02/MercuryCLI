#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolrow-pulse-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { AssistantToolUseMessage } = await import(
  '../../src/screen/messages/AssistantToolUseMessage.js'
)
const { BashTool } = await import('../../src/tools/shell/BashTool.js')
const { ReadTool } = await import('../../src/tools/read/ReadTool.js')
const { liveTurnStateOf } = await import('../../src/sessions/resume/conversationRecovery.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { WORK_FRAMES } = await import('../../src/screen/cockpit/liveGlyphs.js')
const { GLYPH } = await import('../../src/screen/theme/glyphs.js')
const { BLACK_CIRCLE } = await import('../../src/screen/theme/rowGlyphs.js')
const { TOOL_FAMILY_MARKS } = await import('../../src/screen/widgets/toolGlyphs.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}${cond ? '' : ' [change liveTurnStateOf in src/sessions/resume/conversationRecovery.ts (which calls are in progress), AssistantToolUseMessage in src/screen/messages/AssistantToolUseMessage.tsx (the row lead and the running body), or viewInProgressToolUseIDs in src/screen/chat/useChatStatus.tsx (the daemon-hosted set)]'}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

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
const reply = (at: number): RawMsg => ({
  type: 'assistant',
  uuid: `a-${at}`,
  timestamp: new Date(at).toISOString(),
  message: { id: `msg-${at}`, role: 'assistant', content: [{ type: 'text', text: 'the build passed' }] },
})
const answeredFold = liveTurnStateOf([prompt(1000), toolUse(2000, [TOOL_ID]), reply(4000)] as never)
check(
  'a later reply resolves a call whose result record is missing — the pulse never runs past the reply',
  answeredFold.inProgressToolUseIDs.size === 0 && !answeredFold.inFlight,
  JSON.stringify({ ids: [...answeredFold.inProgressToolUseIDs], inFlight: answeredFold.inFlight }),
)
const lastCallFold = liveTurnStateOf([prompt(1000), toolUse(2000, [TOOL_ID]), reply(4000), toolUse(5000, [OTHER_ID])] as never)
check(
  '…and only the newest reply\'s own call is the one that pulses',
  lastCallFold.inProgressToolUseIDs.has(OTHER_ID) && lastCallFold.inProgressToolUseIDs.size === 1,
  JSON.stringify([...lastCallFold.inProgressToolUseIDs]),
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
const SHELL = TOOL_FAMILY_MARKS.shell.glyph
const READ = TOOL_FAMILY_MARKS.read.glyph
const leadsWith = (row: string, lead: string, name: string): boolean => row.replace(/^\d\d:\d\d:\d\d \[Mercury\] /, '').startsWith(`${lead} ${name}`)

const runningRow = await renderRow({
  tool: BashTool,
  name: 'Bash',
  input: { command: 'bun run build.ts' },
  inProgress: runningFold.inProgressToolUseIDs,
  lookups: baseLookups(),
})
check(
  'the RUNNING row leads with the shell mark and no work glyph',
  leadsWith(runningRow, SHELL, 'Bash') && !workFamily(runningRow),
  JSON.stringify(runningRow),
)
check(
  '…and shows the live progress body under the header (running…)',
  runningRow.includes('running…'),
  JSON.stringify(runningRow),
)
check('…and never wears a settle mark while running', !runningRow.includes(BLACK_CIRCLE) && !runningRow.includes(GLYPH.warn))

const settledRow = await renderRow({
  tool: BashTool,
  name: 'Bash',
  input: { command: 'bun run build.ts' },
  inProgress: settledFold.inProgressToolUseIDs,
  lookups: baseLookups({ resolvedToolUseIDs: new Set([TOOL_ID]) }),
})
check(
  'the SETTLED row leads with the shell mark alone — no dot, no work glyph',
  leadsWith(settledRow, SHELL, 'Bash') && !settledRow.includes(BLACK_CIRCLE) && !workFamily(settledRow),
  JSON.stringify(settledRow),
)
check('…and the progress body is gone at settle', !settledRow.includes('running…'))

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
  'an ERRORED row leads with the shell mark, never a warn glyph or the pulse',
  leadsWith(erroredRow, SHELL, 'Bash') && !erroredRow.includes(GLYPH.warn) && !workFamily(erroredRow),
  JSON.stringify(erroredRow),
)

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
check('a DENIED row leads with ✕ in the mark\'s place', leadsWith(deniedRow, GLYPH.fail, 'Bash') && !deniedRow.includes(SHELL) && !workFamily(deniedRow), JSON.stringify(deniedRow))

const readRow = await renderRow({
  tool: ReadTool,
  name: 'Read',
  input: { file_path: '/scratch/notes.md' },
  inProgress: new Set<string>(),
  lookups: baseLookups({ resolvedToolUseIDs: new Set([TOOL_ID]) }),
})
check('a resolved READ leads with the read mark, never a ring', leadsWith(readRow, READ, 'Read') && !readRow.includes(GLYPH.read) && !workFamily(readRow), JSON.stringify(readRow))

section('§C the daemon-hosted feed seams (source locks, call-shaped)')
{
  {
    const { openStatusPart } = await import('../ui/chatScenarios.ts')
    const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
    const status = await openStatusPart('toolrow-pulse-status', { keepHome: true })
    const liveSet = new Set(['toolu_live_1', 'toolu_live_2'])
    await status.plant({ seatLive: { ...IDLE_LIVE, inFlight: true, phase: 'tool', inProgressToolUseIDs: liveSet } })
    const viewSet = status.part.value().viewInProgressToolUseIDs
    await status.close()
    check("the Chat's view set is the CONNECTOR's live set (the daemon-hosted feed)", viewSet === liveSet, `${[...viewSet].join(',')}`)
  }
}

console.log(
  failures === 0
    ? '\n✅ TOOLROW LIVE-PULSE LAW HOLDS (running wears it, settle stops it)'
    : `\n❌ ${failures} TOOLROW LIVE-PULSE CHECK(S) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

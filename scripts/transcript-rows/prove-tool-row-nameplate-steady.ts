#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'nameplate-steady-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.TZ = 'UTC'
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const src = (rel: string): string => join(ROOT, 'src', rel)
const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default as typeof import('react')
const { enableConfigs } = await import(src('platform/config/globalConfig.ts'))
enableConfigs()
const { renderToAnsiString } = await import(src('screen/renderer/staticRender.tsx'))
const { Box } = await import(src('screen/themedRenderer.ts'))
const { AppStateProvider } = await import(src('screen/app-state/AppState.tsx'))
const { getDefaultAppState } = await import(src('screen/app-state/AppStateStore.ts'))
const { KeybindingSetup } = await import(src('screen/keys/KeybindingProviderSetup.tsx'))
const { Messages, isAssistantContinuationRow } = await import(src('screen/messages/Messages.tsx'))
const { MessageRow } = await import(src('screen/messages/MessageRow.tsx'))
const { NameplateContinuationContext } = await import(src('screen/messages/TranscriptNameplate.tsx'))
const { deriveTranscriptRows } = await import(src('screen/concourse/workerTranscriptFold.ts'))
const { createStreamingTailStore } = await import(src('engine/message-shapes/streamingTailStore.ts'))
const { createAssistantMessage, createUserMessage } = await import(src('engine/message-shapes/factories.ts'))
const { ReadTool } = await import(src('tools/read/ReadTool.ts'))
const { GrepTool } = await import(src('tools/grep/GrepTool.ts'))
const { BashTool } = await import(src('tools/shell/BashTool.tsx'))
const { EditTool } = await import(src('tools/edit/EditTool.ts'))
const { CrewmateTool } = await import(src('tools/crewmate/CrewmateTool.tsx'))
import type { Message as WireMessage } from '../../src/engine/message-shapes/message.js'
import type { Tools } from '../../src/tools/kit/tool.js'

const h = React.createElement
let checks = 0
let failures = 0
const FIX_HINT = 'fix isAssistantContinuationRow in src/screen/messages-list/transcript.ts so a row after an unresolved tool_use keeps the same speaker prefix it wears once that call settles'
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${FIX_HINT}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const STAMP = '2026-11-26T13:48:36.000Z'
const CLOCK = '13:48:36'
const PLATE = `${CLOCK} [Mercury]`
const TOOLS: Tools = [EditTool, BashTool, ReadTool, GrepTool, CrewmateTool]

async function paintMessages(
  messages: WireMessage[],
  opts: {
    inProgress?: Set<string>
    isLoading?: boolean
    streamingText?: string
  } = {},
): Promise<string[]> {
  const streamingTail = opts.streamingText !== undefined ? createStreamingTailStore() : null
  if (streamingTail && opts.streamingText !== undefined) {
    streamingTail.reset(opts.streamingText)
  }
  const node = h(
    AppStateProvider,
    { initialState: { ...getDefaultAppState(), expandedView: 'none' }, children: null },
    h(
      KeybindingSetup,
      null,
      h(Messages, {
        messages,
        tools: TOOLS,
        commands: [],
        verbose: false,
        toolJSX: null,
        toolUseConfirmQueue: [],
        inProgressToolUseIDs: opts.inProgress ?? new Set<string>(),
        isRewindPickerVisible: false,
        conversationId: 'nameplate-steady',
        screen: 'prompt',
        streamingToolUses: [],
        isLoading: opts.isLoading ?? false,
        suppressLogo: true,
        streamingTail,
        streamingTextSuppressed: false,
      }),
    ),
  )
  return stripAnsi(await renderToAnsiString(node, 120))
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
}

async function paintMirror(messages: WireMessage[]): Promise<string[]> {
  const derived = deriveTranscriptRows(messages, TOOLS)
  const node = h(
    AppStateProvider,
    { initialState: { ...getDefaultAppState(), expandedView: 'none' }, children: null },
    h(
      Box,
      { flexDirection: 'column' },
      ...derived.collapsed.map((m, i) =>
        h(
          NameplateContinuationContext.Provider,
          { key: m.uuid, value: isAssistantContinuationRow(derived.collapsed, i) },
          h(MessageRow, {
            message: m,
            isUserContinuation: m.type === 'user' && derived.collapsed[i - 1]?.type === 'user',
            hasContentAfter: false,
            tools: TOOLS,
            commands: [],
            verbose: false,
            inProgressToolUseIDs: derived.inProgress,
            streamingToolUseIDs: new Set<string>(),
            screen: 'prompt',
            canAnimate: false,
            lastThinkingBlockId: null,
            latestBashOutputUUID: null,
            columns: 120,
            isLoading: derived.inProgress.size > 0,
            lookups: derived.lookups,
          }),
        ),
      ),
    ),
  )
  return stripAnsi(await renderToAnsiString(node, 120))
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
}

const promptMsg: WireMessage = {
  ...createUserMessage({ content: 'post status and check files' }),
  timestamp: STAMP,
}

section('§1 mounted <Messages>: one assistant message with two tool calls, first unresolved then settled')
{
  const twoCalls: WireMessage = {
    ...createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'tu_first', name: 'Edit', input: { file_path: '/scratch/first.ts', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 'tu_second', name: 'Edit', input: { file_path: '/scratch/second.ts', old_string: 'c', new_string: 'd' } },
      ],
    }),
    timestamp: STAMP,
  }
  const firstResult: WireMessage = {
    ...createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tu_first', content: 'ok' }],
    }),
    timestamp: STAMP,
  }
  const secondResult: WireMessage = {
    ...createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tu_second', content: 'ok' }],
    }),
    timestamp: STAMP,
  }
  const inFlight = await paintMessages([promptMsg, twoCalls], {
    inProgress: new Set(['tu_first', 'tu_second']),
    isLoading: true,
  })
  const firstSettled = await paintMessages([promptMsg, twoCalls, firstResult], {
    inProgress: new Set(['tu_second']),
    isLoading: true,
  })
  const bothSettled = await paintMessages([promptMsg, twoCalls, firstResult, secondResult], {
    inProgress: new Set(),
    isLoading: false,
  })
  const lineOf = (rows: string[], needle: string): string => rows.find(r => r.includes(needle)) ?? ''
  const secondInFlight = lineOf(inFlight, 'second.ts')
  const secondAfterFirst = lineOf(firstSettled, 'second.ts')
  const secondSettled = lineOf(bothSettled, 'second.ts')
  console.log(`  in flight:    |${secondInFlight}|`)
  console.log(`  first done:   |${secondAfterFirst}|`)
  check('second tool row carries time and [Mercury] while first call is unresolved', secondInFlight.startsWith(`  ${PLATE} Update`), JSON.stringify(secondInFlight))
  check('second tool row carries time and [Mercury] once first call settles', secondAfterFirst.startsWith(`  ${PLATE} Update`), JSON.stringify(secondAfterFirst))
  check('second tool row does not move a single cell when the first call settles', secondInFlight === secondAfterFirst && secondInFlight.indexOf('Update') === secondSettled.indexOf('Update'), JSON.stringify({ secondInFlight, secondAfterFirst, secondSettled }))
}

section('§2 owner scene: unresolved tool call followed by collapsed read/search group')
{
  const ownerTurn: WireMessage = {
    ...createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'tu_cb', name: 'Edit', input: { file_path: '/scratch/board.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', id: 'tu_r1', name: 'Read', input: { file_path: '/scratch/a.ts' } },
        { type: 'tool_use', id: 'tu_r2', name: 'Read', input: { file_path: '/scratch/b.ts' } },
        { type: 'tool_use', id: 'tu_g1', name: 'Grep', input: { pattern: 'foo' } },
      ],
    }),
    timestamp: STAMP,
  }
  const cbDone: WireMessage = {
    ...createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tu_cb', content: 'ok' }],
    }),
    timestamp: STAMP,
  }
  const inFlight = await paintMessages([promptMsg, ownerTurn], {
    inProgress: new Set(['tu_cb', 'tu_r1', 'tu_r2', 'tu_g1']),
    isLoading: true,
  })
  const afterCb = await paintMessages([promptMsg, ownerTurn, cbDone], {
    inProgress: new Set(['tu_r1', 'tu_r2', 'tu_g1']),
    isLoading: true,
  })
  const grpInFlight = inFlight.find(r => r.includes('Searching') || r.includes('Reading')) ?? ''
  const grpAfterCb = afterCb.find(r => r.includes('Searching') || r.includes('Reading')) ?? ''
  console.log(`  group in flight: |${grpInFlight}|`)
  console.log(`  group after cb:  |${grpAfterCb}|`)
  check('collapsed group after unresolved tool row carries time and [Mercury] in flight', grpInFlight.startsWith(`  ${PLATE} `), JSON.stringify(grpInFlight))
  check('collapsed group stays at the exact same cells when the earlier call settles', grpInFlight === grpAfterCb, JSON.stringify({ grpInFlight, grpAfterCb }))
}

section('§3 Session Manager mirror (workerTranscriptFold + isAssistantContinuationRow): same rule')
{
  const twoCalls: WireMessage = {
    ...createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'tu_m1', name: 'Edit', input: { file_path: '/scratch/m1.ts', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 'tu_m2', name: 'Edit', input: { file_path: '/scratch/m2.ts', old_string: 'c', new_string: 'd' } },
      ],
    }),
    timestamp: STAMP,
  }
  const m1Done: WireMessage = {
    ...createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tu_m1', content: 'ok' }],
    }),
    timestamp: STAMP,
  }
  const mirrorInFlight = await paintMirror([promptMsg, twoCalls])
  const mirrorSettled = await paintMirror([promptMsg, twoCalls, m1Done])
  const rowInFlight = mirrorInFlight.find(r => r.includes('m2.ts')) ?? ''
  const rowSettled = mirrorSettled.find(r => r.includes('m2.ts')) ?? ''
  check('mirror: second tool row carries [Mercury] while first is unresolved', rowInFlight.startsWith(`  ${PLATE} Update`), JSON.stringify(rowInFlight))
  check('mirror: second tool row does not move when first settles', rowInFlight === rowSettled, JSON.stringify({ rowInFlight, rowSettled }))
}

section('§4 cases that must not change: prose, thinking, grouped launch, collapsed group, streaming nameplate')
{
  const proseAfterTool: WireMessage[] = [
    promptMsg,
    { ...createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_p1', name: 'Edit', input: { file_path: '/scratch/p.ts', old_string: 'a', new_string: 'b' } }] }), timestamp: STAMP },
    { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu_p1', content: 'ok' }] }), timestamp: STAMP },
    { ...createAssistantMessage({ content: [{ type: 'text', text: 'All clear now.' }] }), timestamp: STAMP },
  ]
  const proseLines = await paintMessages(proseAfterTool)
  const proseRow = proseLines.find(r => r.includes('All clear now.')) ?? ''
  check('prose after a settled tool row keeps its [Mercury] nameplate', proseRow.includes(PLATE), JSON.stringify(proseRow))

  const twoProse: WireMessage[] = [
    promptMsg,
    { ...createAssistantMessage({ content: [{ type: 'text', text: 'First paragraph.' }, { type: 'text', text: 'Second paragraph.' }] }), timestamp: STAMP },
  ]
  const twoProseLines = await paintMessages(twoProse)
  const firstP = twoProseLines.find(r => r.includes('First paragraph.')) ?? ''
  const secondP = twoProseLines.find(r => r.includes('Second paragraph.')) ?? ''
  check('consecutive assistant prose keeps continuation suppression on the second row', firstP.includes(PLATE) && !secondP.includes(PLATE), JSON.stringify({ firstP, secondP }))

  const afterThinking: WireMessage[] = [
    promptMsg,
    {
      ...createAssistantMessage({
        content: [
          { type: 'thinking', thinking: 'weighing options', signature: 'sig-1' },
          { type: 'tool_use', id: 'tu_th', name: 'Edit', input: { file_path: '/scratch/th.ts', old_string: 'a', new_string: 'b' } },
        ],
      }),
      timestamp: STAMP,
    },
    { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu_th', content: 'ok' }] }), timestamp: STAMP },
  ]
  const thinkingLines = await paintMessages(afterThinking)
  const afterThinkRow = thinkingLines.find(r => r.includes('th.ts')) ?? ''
  check('tool row after thinking keeps its [Mercury] nameplate', afterThinkRow.startsWith(`  ${PLATE} Update`), JSON.stringify(afterThinkRow))

  const groupedLaunch: WireMessage[] = [
    promptMsg,
    {
      ...createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'tu_cm1', name: 'Crewmate', input: { name: 'a1', description: 'a1', prompt: 'go', run_in_background: true } },
          { type: 'tool_use', id: 'tu_cm2', name: 'Crewmate', input: { name: 'a2', description: 'a2', prompt: 'go', run_in_background: true } },
        ],
      }),
      timestamp: STAMP,
    },
    { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu_cm1', content: 'launched' }] }), toolUseResult: { status: 'async_launched', agentId: 'a1' }, timestamp: STAMP },
    { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu_cm2', content: 'launched' }] }), toolUseResult: { status: 'async_launched', agentId: 'a2' }, timestamp: STAMP },
  ]
  const groupedLines = await paintMessages(groupedLaunch)
  const groupedHead = groupedLines.find(r => r.includes('2 background crewmates launched')) ?? ''
  check('grouped launch keeps its col-2 [Mercury] nameplate and single space', groupedHead === `  ${PLATE} 2 background crewmates launched`, JSON.stringify(groupedHead))

  const collapsedThenProse: WireMessage[] = [
    promptMsg,
    {
      ...createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'tu_cr1', name: 'Read', input: { file_path: '/scratch/x.ts' } },
          { type: 'tool_use', id: 'tu_cr2', name: 'Read', input: { file_path: '/scratch/y.ts' } },
        ],
      }),
      timestamp: STAMP,
    },
    { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu_cr1', content: 'ok' }] }), timestamp: STAMP },
    { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu_cr2', content: 'ok' }] }), timestamp: STAMP },
    { ...createAssistantMessage({ content: [{ type: 'text', text: 'Done reading.' }] }), timestamp: STAMP },
  ]
  const collapsedLines = await paintMessages(collapsedThenProse)
  const collapsedHead = collapsedLines.find(r => r.includes('Read 2 files')) ?? ''
  const afterCollapsedProse = collapsedLines.find(r => r.includes('Done reading.')) ?? ''
  check('settled collapsed read/search group carries [Mercury] and prose after it keeps its continuation behavior', collapsedHead.startsWith(`  ${PLATE} Read 2 files`) && !afterCollapsedProse.includes(PLATE), JSON.stringify({ collapsedHead, afterCollapsedProse }))

  const streamingLines = await paintMessages([promptMsg], { isLoading: true, streamingText: 'Streaming answer now' })
  const streamRow = streamingLines.find(r => r.includes('Streaming answer now')) ?? ''
  check('streaming nameplate still paints [Mercury] independently', streamRow.includes('[Mercury]'), JSON.stringify(streamRow))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-tool-row-nameplate-steady: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

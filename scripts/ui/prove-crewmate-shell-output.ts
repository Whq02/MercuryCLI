import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mountOffscreen, pinSourceRef, settle, waitFor } from '../lib/settingsPopupHarness.js'
import { encodeSeedTranscript } from '../lib/seedTranscript.js'
import type { Message, NormalizedUserMessage } from '../../src/types/message.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
const home = process.env.MERCURY_CONFIG_DIR!
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider, getDefaultAppState } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { useCrewmateTranscript, crewmateTranscriptFile } = await import('../../src/components/tasks/useCrewmateTranscript.js')
const { UserToolResultMessage } = await import('../../src/components/messages/UserToolResultMessage/UserToolResultMessage.js')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.js')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const h = React.createElement
const hosted = { sessionId: 'shell-output-session', originalCwd: home }
const resting = noSessionConnector()
setFocusedSessionConnector(new Proxy(resting, {
  get(target, prop, receiver) {
    if (prop === 'sessionId') return () => hosted.sessionId
    if (prop === 'workspace') return () => ({ cwd: home, originalCwd: home })
    const value = Reflect.get(target, prop, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
}))
const crewmate = { taskId: 'shell-output-crew', local: undefined, name: 'shell-output', facts: { transcriptAgentId: 'shell-output-crew', running: false, endedAt: 100 }, pinned: false, running: 0 } as never
const file = crewmateTranscriptFile(crewmate, hosted)!
const output = 'CREW-SHELL-OUTPUT\nsecond recorded line'
const row = (n: number, extra: Record<string, unknown>): Record<string, unknown> => ({
  uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  parentUuid: n === 0 ? null : `00000000-0000-4000-8000-${String(n - 1).padStart(12, '0')}`,
  timestamp: '2026-06-19T12:00:00.000Z', agentId: 'shell-output-crew', isSidechain: true,
  sessionId: hosted.sessionId, cwd: home, version: '1.0.0', ...extra,
})
const rows = [
  row(0, { type: 'assistant', message: { id: 'call-row', role: 'assistant', type: 'message', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'shell-call', name: 'Bash', input: { command: 'printf fixture' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } }),
  row(1, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shell-call', content: output }] } }),
]
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, encodeSeedTranscript(rows, hosted.sessionId))
let checks = 0
let failures = 0
function check(label: string, ok: boolean): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
let loaded: Message[] = []
function Results({ messages }: { messages: Message[] }): React.ReactNode {
  const normalized = normalizeMessages(messages)
  const lookups = buildMessageLookups(normalized, messages)
  return h(Box, { flexDirection: 'column' }, ...normalized.flatMap(message => {
    if (message.type !== 'user') return []
    return message.message.content.flatMap(param => param.type === 'tool_result' ? [h(UserToolResultMessage, { key: param.tool_use_id, message, param, lookups, tools: [BashTool], progressMessagesForMessage: [], verbose: true, width: 98, isTranscriptMode: true })] : [])
  }))
}
function Crew(): React.ReactNode {
  const transcript = useCrewmateTranscript(crewmate, 1)
  loaded = transcript?.messages ?? []
  return h(Box, { flexDirection: 'column' }, h(Text, null, transcript?.state), h(Results, { messages: loaded }))
}
const wrap = (node: React.ReactNode): React.ReactNode => h(AppStateProvider, { initialState: getDefaultAppState(), children: h(ThemeProvider, null, h(Box, { width: 100, height: 24, flexDirection: 'column' }, node)) })
const view = await mountOffscreen(wrap(h(Crew)), 100, 24)
try {
  check('the real crew hook loads both recorded rows', await waitFor(() => loaded.length === 2, 3000))
  const result = loaded.find(message => message.type === 'user') as NormalizedUserMessage
  check('the result content survives disk without structured result metadata', result?.toolUseResult === undefined && JSON.stringify(result?.message.content).includes(output.split('\n')[0]!))
  await settle(100)
  const crewFrame = view.screen()
  check('the crew transcript paints both recorded shell lines', crewFrame.includes('CREW-SHELL-OUTPUT') && crewFrame.includes('second recorded line'))
  const framesAt = process.argv.indexOf('--frames')
  if (framesAt >= 0) {
    const frames = process.argv[framesAt + 1]!
    mkdirSync(frames, { recursive: true })
    writeFileSync(join(frames, 'recorded-bash-100x24.txt'), `${view.lines().join('\n')}\n`)
  }
  const direct = loaded.map(message => message.type === 'user' ? { ...message, toolUseResult: { stdout: output, stderr: '', interrupted: false } } : message)
  view.resize(wrap(h(Box, { flexDirection: 'column' }, h(Text, null, 'ready'), h(Results, { messages: direct }))), 100, 24)
  await settle(100)
  check('the ordinary structured shell result paints its output', view.screen().includes('CREW-SHELL-OUTPUT') && view.screen().includes('second recorded line'))
  check('the recorded crew output has the same frame as the ordinary result', crewFrame === view.screen())
  const blocks = loaded.map(message => message.type === 'user' ? { ...message, toolUseResult: null, message: { ...message.message, content: [{ type: 'tool_result', tool_use_id: 'shell-call', content: [{ type: 'text', text: 'FIRST-TEXT-BLOCK' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMAGE-PAYLOAD-MUST-NOT-PAINT' } }, { type: 'text', text: 'LAST-TEXT-BLOCK' }] }] } } as Message : message)
  view.resize(wrap(h(Results, { messages: blocks })), 100, 24)
  await settle(100)
  check('text blocks paint in order when the stored result metadata is null', view.screen().includes('FIRST-TEXT-BLOCK') && view.screen().indexOf('LAST-TEXT-BLOCK') > view.screen().indexOf('FIRST-TEXT-BLOCK'))
  check('image payloads are not printed as text', !view.screen().includes('IMAGE-PAYLOAD'))
  const failed = loaded.map(message => message.type === 'user' ? { ...message, message: { ...message.message, content: [{ type: 'tool_result', tool_use_id: 'shell-call', content: 'fixture failed', is_error: true }] } } as Message : message)
  view.resize(wrap(h(Results, { messages: failed })), 100, 24)
  await settle(100)
  check('an error still takes the error renderer', view.screen().includes('fixture failed'))
  const blank = loaded.map(message => message.type === 'user' ? { ...message, message: { ...message.message, content: [{ type: 'tool_result', tool_use_id: 'shell-call', content: '' }] } } as Message : message)
  view.resize(wrap(h(Results, { messages: blank })), 100, 24)
  await settle(100)
  check('an empty stored result invents no output', view.screen().trim() === '')
  const otherTool = loaded.map(message => message.type === 'assistant' ? { ...message, message: { ...message.message, content: [{ type: 'tool_use', id: 'shell-call', name: 'Sleep', input: { seconds: 4 } }] } } as Message : message)
  const { SleepTool } = await import('../../src/tools/SleepTool/SleepTool.js')
  const normalized = normalizeMessages(otherTool)
  const lookups = buildMessageLookups(normalized, otherTool)
  const otherResult = normalized.find(message => message.type === 'user') as NormalizedUserMessage
  const param = otherResult.message.content[0]!
  if (param.type !== 'tool_result') throw new Error('the fixture result is absent')
  view.resize(wrap(h(UserToolResultMessage, { message: otherResult, param, lookups, tools: [SleepTool], progressMessagesForMessage: [], verbose: true, width: 98, isTranscriptMode: true })), 100, 24)
  await settle(100)
  check('a non-shell result without metadata keeps its existing empty row', view.screen().trim() === '')
} finally {
  view.unmount()
  releaseFocusedSessionConnector()
}
console.log(`${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

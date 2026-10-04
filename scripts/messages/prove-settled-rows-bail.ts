#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'settled-rows-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_FULLSCREEN = '1'
delete process.env.MERCURY_HOME

const messagesModule = (await import(join(ROOT, 'src/components/Messages.tsx'))) as {
  composeTranscript?: (input: Record<string, unknown>) => { collapsed: Array<{ type: string; uuid: string }>; lookups: unknown }
  reuseSettledRows?: (previous: readonly unknown[], next: unknown[]) => unknown[]
}
const { areMessageRowPropsEqual } = await import(join(ROOT, 'src/components/MessageRow.tsx'))
const { normalizeMessages } = await import(join(ROOT, 'src/utils/messages/normalize.ts'))
const { isNotEmptyMessage } = await import(join(ROOT, 'src/utils/messages/text.ts'))
const { reorderMessagesInUI } = await import(join(ROOT, 'src/utils/messages/uiOrder.ts'))
const { buildMessageLookups } = await import(join(ROOT, 'src/utils/messages/lookups.ts'))
const { applyGrouping } = await import(join(ROOT, 'src/utils/groupToolUses.ts'))
const { collapseReadSearchGroups } = await import(join(ROOT, 'src/utils/collapseReadSearch.ts'))
const { injectTurnReceipts } = await import(join(ROOT, 'src/utils/cockpit/turnReceipt.ts'))
const { getMercuryTempDir } = await import(join(ROOT, 'src/utils/permissions/filesystem.ts'))
const { getTools } = await import(join(ROOT, 'src/tools.ts'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const baseCompose = (input: Record<string, unknown>): { collapsed: Array<{ type: string; uuid: string }>; lookups: unknown } => {
  const normalized = input.normalized as unknown[]
  const working = reorderMessagesInUI(normalized as never, [] as never) as unknown[]
  let collapsed = applyGrouping(working as never, input.tools as never, false).messages as unknown[]
  collapsed = injectTurnReceipts(collapsed as never, getMercuryTempDir()) as unknown[]
  collapsed = collapseReadSearchGroups(collapsed as never, input.tools as never, input.inProgressToolUseIDs as Set<string>) as unknown[]
  return { collapsed: collapsed as Array<{ type: string; uuid: string }>, lookups: buildMessageLookups(normalized as never, working as never) }
}
const composeTranscript = messagesModule.composeTranscript ?? baseCompose
const reuseSettledRows = messagesModule.reuseSettledRows ?? ((_previous: readonly unknown[], next: unknown[]): unknown[] => next)
check('the tip exports the composition and the settled-row reuse (absent on the base: the proof reads through the pipeline pieces)', messagesModule.composeTranscript !== undefined && messagesModule.reuseSettledRows !== undefined)

const tools = getTools(getDefaultAppState().toolPermissionContext)
const T0 = 1_760_000_000_000
const iso = (at: number): string => new Date(at).toISOString()
type Rec = Record<string, unknown>
const userRow = (uuid: string, at: number, text: string): Rec => ({ type: 'user', uuid, timestamp: iso(at), message: { role: 'user', content: text } })
const assistantRow = (uuid: string, at: number, content: unknown[]): Rec => ({
  type: 'assistant',
  uuid,
  timestamp: iso(at),
  requestId: `req_${uuid}`,
  message: { id: `msg_${uuid}`, type: 'message', role: 'assistant', model: 'fixture-model', content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})
const read = (id: string, path: string): unknown => ({ type: 'tool_use', id, name: 'Read', input: { file_path: path } })
const bash = (id: string, command: string): unknown => ({ type: 'tool_use', id, name: 'Bash', input: { command } })
const resultRow = (uuid: string, at: number, toolUseId: string, text: string, result: unknown): Rec => ({
  type: 'user',
  uuid,
  timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  toolUseResult: result,
})
const readResult = { type: 'text', file: { filePath: '/w/a.ts', content: 'export const a = 1', numLines: 1, startLine: 1, totalLines: 1 } }

const turn: Rec[] = [
  userRow('u-1', T0, 'read the two files, then run the build'),
  assistantRow('a-1', T0 + 1_000, [read('r-1', '/w/a.ts')]),
  resultRow('u-r1', T0 + 1_500, 'r-1', 'export const a = 1', readResult),
  assistantRow('a-2', T0 + 2_000, [read('r-2', '/w/b.ts')]),
  resultRow('u-r2', T0 + 2_500, 'r-2', 'export const b = 2', readResult),
  assistantRow('a-3', T0 + 3_000, [bash('b-1', 'bun run build.ts')]),
  resultRow('u-b1', T0 + 4_000, 'b-1', 'BUILD OK', { stdout: 'BUILD OK', stderr: '', interrupted: false }),
  assistantRow('a-4', T0 + 5_000, [{ type: 'text', text: 'Both files read; the build is green.' }]),
]
const later: Rec[] = [...turn, userRow('u-2', T0 + 60_000, 'now the second file again')]

const compose = (wire: Rec[], inProgress: Set<string> = new Set()) => {
  const normalized = normalizeMessages(wire as never).filter(isNotEmptyMessage as never)
  return composeTranscript({ normalized, syntheticStreamingRows: [], verbose: false, fullscreen: true, isTranscriptMode: false, truncateTranscript: false, tools, inProgressToolUseIDs: inProgress })
}

section('§1 the derived rows of a settled turn keep their identity across a transcript tick')
const first = compose(turn)
const second = compose(later)
const collapsedFirst = first.collapsed.find(row => row.type === 'collapsed_read_search')
const collapsedSecond = second.collapsed.find(row => row.type === 'collapsed_read_search')
check('the two reads fold into one collapsed group on both compositions', collapsedFirst !== undefined && collapsedSecond !== undefined && collapsedFirst.uuid === collapsedSecond.uuid, JSON.stringify(second.collapsed.map(r => [r.type, r.uuid])))
check('a fresh composition mints a fresh group object (the cost the reuse removes)', collapsedFirst !== collapsedSecond)
const reused = reuseSettledRows(first.collapsed, second.collapsed) as Array<{ type: string; uuid: string }>
const groupReused = reused.find(row => row.type === 'collapsed_read_search')
check('RED ON THE BASE: the settled group row comes back as the object the previous composition handed out', groupReused === collapsedFirst)
const plain = reused.filter(row => row.type === 'user' || row.type === 'assistant')
check('the plain rows keep the identity the normaliser already gives them', plain.every(row => first.collapsed.includes(row as never) || row.uuid === 'u-2'))
check('the appended row is the new object, untouched', reused[reused.length - 1]!.uuid === 'u-2' && reused[reused.length - 1] === second.collapsed[second.collapsed.length - 1])
check('a row that was not in the previous composition passes through', reuseSettledRows([], second.collapsed) === second.collapsed)

section('§2 a changed group is never reused')
const changed: Rec[] = turn.map(row => (row.uuid === 'u-r2' ? resultRow('u-r2', T0 + 2_500, 'r-2', 'export const b = 3', readResult) : row))
const third = compose(changed)
const groupChanged = (reuseSettledRows(first.collapsed, third.collapsed) as Array<{ type: string }>).find(row => row.type === 'collapsed_read_search')
check('a member result that changed identity makes the group a new object', groupChanged !== collapsedFirst && groupChanged === third.collapsed.find(row => row.type === 'collapsed_read_search'))

section('§3 the row memo bails for a settled derived row and never for a live one')
const rowProps = (message: unknown, lookups: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  message,
  isUserContinuation: false,
  hasContentAfter: true,
  tools,
  commands: [],
  verbose: false,
  inProgressToolUseIDs: new Set<string>(),
  streamingToolUseIDs: new Set<string>(),
  screen: 'prompt',
  canAnimate: true,
  lastThinkingBlockId: null,
  latestBashOutputUUID: null,
  columns: 120,
  isLoading: false,
  lookups,
  ...over,
})
check('RED ON THE BASE: a settled collapsed group on the chat screen bails on a tick that changed nothing of its own', areMessageRowPropsEqual(rowProps(collapsedFirst, first.lookups) as never, rowProps(collapsedFirst, second.lookups) as never))
const receiptFirst = first.collapsed.find(row => row.type === 'turn_receipt')
const receiptReused = reused.find(row => row.type === 'turn_receipt')
check('the turn receipt is reused and bails the same way', receiptFirst !== undefined && receiptReused === receiptFirst && areMessageRowPropsEqual(rowProps(receiptFirst, first.lookups) as never, rowProps(receiptFirst, second.lookups) as never))
const running = compose(turn.filter(row => row.uuid !== 'u-r2' && !['a-3', 'u-b1', 'a-4'].includes(row.uuid as string)), new Set(['r-2']))
const runningGroup = running.collapsed.find(row => row.type === 'collapsed_read_search')
check('a group with a member still running keeps re-rendering', runningGroup !== undefined && !areMessageRowPropsEqual(rowProps(runningGroup, running.lookups, { inProgressToolUseIDs: new Set(['r-2']) }) as never, rowProps(runningGroup, running.lookups, { inProgressToolUseIDs: new Set(['r-2']) }) as never), JSON.stringify(running.collapsed.map(r => [r.type, r.uuid])))
check('a member leaving the in-flight set re-renders the settled row once', !areMessageRowPropsEqual(rowProps(collapsedFirst, first.lookups, { inProgressToolUseIDs: new Set(['r-2']) }) as never, rowProps(collapsedFirst, first.lookups) as never))
check('the loading flag flipping re-renders a collapsed group (its active verdict reads it)', !areMessageRowPropsEqual(rowProps(collapsedFirst, first.lookups, { isLoading: true }) as never, rowProps(collapsedFirst, first.lookups) as never))
check('a member result moving re-renders the settled group', !areMessageRowPropsEqual(rowProps(collapsedFirst, first.lookups) as never, rowProps(collapsedFirst, third.lookups) as never))

console.log(`\n${'─'.repeat(76)}`)
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

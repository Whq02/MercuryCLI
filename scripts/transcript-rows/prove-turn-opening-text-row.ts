;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message, RenderableMessage } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'turn-opening-text-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
delete process.env.MERCURY_TURN_RECEIPT
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { Message: MessageView } = await import('../../src/components/Message.tsx')
const { composeTranscript } = await import('../../src/components/Messages.tsx')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { isNotEmptyMessage } = await import('../../src/utils/messages/text.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const { buildConversationChain, findLatestMessage } = await import('../../src/utils/sessionStorage/chain.ts')
const { deserializeLiveMessages } = await import('../../src/utils/conversationRecovery.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

const OPENING = 'Before I touch anything: the manifest names the package orchard, so the greeting runs against that name. I will read it, run the greeting three times, and report what came back.'
const CLOSING = 'All three greetings answered; the manifest still names orchard.'
const timestamp = new Date().toISOString()
const tools = getAllBaseTools()

function fixtureTurn(): Message[] {
  const rows: Message[] = [createUserMessage({ content: 'check the manifest and run the greeting three times' })]
  const readId = 'toolu_open_read'
  rows.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: 'msg_open_1', role: 'assistant', content: [{ type: 'text', text: OPENING }, { type: 'tool_use', id: readId, name: 'Read', input: { file_path: join(home, 'package.json') } }], stop_reason: 'tool_use' } } as Message)
  rows.push({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: readId, content: [{ type: 'text', text: '{ "name": "orchard" }' }] }] } } as Message)
  for (let n = 1; n <= 3; n++) {
    const id = `toolu_open_bash_${n}`
    rows.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: `msg_open_bash_${n}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo greeting ${n}`, description: `Greeting ${n}` } }], stop_reason: 'tool_use' } } as Message)
    rows.push({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `greeting ${n}` }] }] }, toolUseResult: { stdout: `greeting ${n}`, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } } as Message)
  }
  rows.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: 'msg_open_final', role: 'assistant', content: [{ type: 'text', text: CLOSING }], stop_reason: 'end_turn' } } as Message)
  return rows
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? `: ${detail}` : ''}`)
}
const textOf = (row: RenderableMessage): string | null => {
  if (row.type !== 'assistant') return null
  const content = row.message.content
  if (!Array.isArray(content)) return null
  const block = content[0] as { type?: string; text?: string } | undefined
  return block?.type === 'text' ? (block.text ?? '') : null
}
const shape = (rows: RenderableMessage[]): string[] =>
  rows.map(row => {
    const text = textOf(row)
    if (text === OPENING) return 'opening'
    if (text === CLOSING) return 'closing'
    if (row.type === 'assistant' && Array.isArray(row.message.content) && (row.message.content[0] as { type?: string })?.type === 'tool_use') return `tool:${(row.message.content[0] as { name?: string }).name}`
    return row.type
  })
const compose = (rows: Message[], fullscreen: boolean): RenderableMessage[] =>
  composeTranscript({ normalized: normalizeMessages(rows).filter(isNotEmptyMessage), syntheticStreamingRows: [], verbose: false, fullscreen, isTranscriptMode: false, truncateTranscript: false, tools, inProgressToolUseIDs: new Set() }).collapsed

function judge(label: string, rows: RenderableMessage[]): void {
  const shaped = shape(rows)
  const opening = shaped.indexOf('opening')
  const closing = shaped.indexOf('closing')
  const firstTool = shaped.findIndex(kind => kind.startsWith('tool:') || kind === 'collapsed_read_search' || kind === 'grouped_tool_use')
  const lastTool = shaped.map((kind, index) => (kind.startsWith('tool:') || kind === 'collapsed_read_search' || kind === 'grouped_tool_use' ? index : -1)).reduce((a, b) => Math.max(a, b), -1)
  check(`${label}: the opening text is its own row, exactly once`, shaped.filter(kind => kind === 'opening').length === 1, shaped.join(' | '))
  check(`${label}: it stands above the first tool row`, opening !== -1 && firstTool !== -1 && opening < firstTool, shaped.join(' | '))
  check(`${label}: the closing text stands after the last tool row, exactly once`, shaped.filter(kind => kind === 'closing').length === 1 && closing > lastTool, shaped.join(' | '))
  check(`${label}: the tools still fold into a group`, shaped.includes('collapsed_read_search'), shaped.join(' | '))
}

try {
  console.log('§1 the composition: a turn that opens with prose, runs tools and closes with prose keeps its opening row')
  const rows = fixtureTurn()
  for (const fullscreen of [true, false]) judge(fullscreen ? 'cockpit' : 'inline', compose(rows, fullscreen))

  console.log('§2 the persisted road: the same turn written and read back through the transcript codec composes the same way')
  const sid = randomUUID()
  let ordinal = 0
  const ctx = { sessionId: sid, nextOrdinal: () => String(++ordinal), observedAt: timestamp, source: { channel: 'sdk' } }
  const persisted = [
    { type: 'mercury-transcript-header', fileVersion: 1, format: 'mercury-records' },
    ...rows.map((row, index) => ({ ...row, parentUuid: index === 0 ? null : rows[index - 1]!.uuid, isSidechain: false, cwd: home, sessionId: sid, version: '1.0.0', gitBranch: 'main' })),
  ]
  const path = join(home, `${sid}.jsonl`)
  writeFileSync(path, persisted.map(entry => JSON.stringify(entryToRecord(entry as never, ctx as never))).join('\n') + '\n')
  const loaded = await loadTranscriptFile(path)
  const latest = findLatestMessage(loaded.messages.values(), (row: { uuid: string; type?: string }) => loaded.leafUuids.has(row.uuid as never) && (row.type === 'user' || row.type === 'assistant'))
  const chain = latest === undefined ? [] : buildConversationChain(loaded.messages, latest)
  const live = deserializeLiveMessages(chain as never) as Message[]
  check('the chain read back carries every row', live.length === rows.length, `${live.length} of ${rows.length}`)
  judge('read back', compose(live, true))

  console.log('§3 the words on screen: the opening row paints its own words before the group, the closing after')
  const composed = compose(rows, true)
  const lookups = buildMessageLookups(normalizeMessages(rows).filter(isNotEmptyMessage), rows)
  const frame = (await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() } as never, ...composed.map(row => React.createElement(MessageView, {
    key: row.uuid,
    message: row,
    messages: composed,
    tools,
    verbose: false,
    addMargin: true,
    shouldAnimate: false,
    shouldShowDot: true,
    isTranscriptMode: false,
    isStatic: true,
    inProgressToolUseIDs: new Set<string>(),
    streamingToolUseIDs: new Set<string>(),
    progressMessagesForMessage: [],
    lookups,
    width: 110,
  }))), 110)).replace(/\s+/g, ' ')
  const at = (words: string): number => frame.indexOf(words)
  const openingAt = at('Before I touch anything')
  const groupAt = at('Read 1 file')
  const closingAt = at('All three greetings answered')
  check('the opening words paint', openingAt !== -1, frame.slice(0, 400))
  check('the group row paints after them', groupAt !== -1 && groupAt > openingAt, frame.slice(0, 600))
  check('the closing words paint after the group', closingAt !== -1 && closingAt > groupAt, frame.slice(0, 800))
  check('the opening words paint once', frame.indexOf('Before I touch anything', openingAt + 1) === -1)
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} turn opening text row (${failures} failures)`)
process.exit(failures ? 1 : 0)

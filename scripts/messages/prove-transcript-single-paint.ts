#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTranscriptFile } from '../../src/utils/sessionStorage/loading.ts'
import { buildConversationChain, findLatestMessage } from '../../src/utils/sessionStorage/chain.ts'
import { deserializeLiveMessages } from '../../src/utils/conversationRecovery.ts'
import { normalizeMessages } from '../../src/utils/messages/normalize.ts'
import { applyGrouping } from '../../src/utils/groupToolUses.ts'
import { injectTurnReceipts } from '../../src/utils/cockpit/turnReceipt.ts'
import { collapseReadSearchGroups } from '../../src/utils/collapseReadSearch.ts'
import { getAllBaseTools } from '../../src/tools.ts'
import { entryToRecord } from '../../src/fabric/entryCodec.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const SID = '11111111-2222-3333-4444-555555555555'
let ordinal = 0
const ctx = {
  sessionId: SID as never,
  nextOrdinal: () => {
    ordinal += 1
    return String(ordinal) as never
  },
  observedAt: new Date(1_788_000_000_000).toISOString(),
  source: { channel: 'sdk' } as never,
}
const U = (n: number): string => `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`
const lines: string[] = []
const push = (entry: Record<string, unknown>): void => {
  lines.push(JSON.stringify(entryToRecord(entry as never, ctx as never)))
}
push({ type: 'mercury-transcript-header', fileVersion: 1, format: 'mercury-records' })
const stamp = (n: number): string => new Date(1_788_000_000_000 + n * 1000).toISOString()
const assistant = (
  uuid: string,
  parentUuid: string,
  model: string,
  pmid: string,
  block: Record<string, unknown>,
  outputTokens = 2,
): Record<string, unknown> => ({
  type: 'assistant',
  uuid,
  parentUuid,
  timestamp: stamp(ordinal + 1),
  sessionId: SID,
  message: {
    id: pmid,
    role: 'assistant',
    model,
    content: [block],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: outputTokens },
  },
})
const userText = (uuid: string, parentUuid: string | null, text: string): Record<string, unknown> => ({
  type: 'user',
  uuid,
  ...(parentUuid ? { parentUuid } : {}),
  timestamp: stamp(ordinal + 1),
  sessionId: SID,
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const toolResult = (uuid: string, parentUuid: string, callId: string): Record<string, unknown> => ({
  type: 'user',
  uuid,
  parentUuid,
  timestamp: stamp(ordinal + 1),
  sessionId: SID,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok' }] },
})

push(userText(U(2), null, 'build the world generator'))
push(assistant(U(3), U(2), 'gpt-fixture', 'openai_pm-1', { type: 'thinking', thinking: 'planning the reads', signature: '' }))
push(assistant(U(4), U(3), 'gpt-fixture', 'openai_pm-1', { type: 'text', text: 'Reading the project first.', citations: null }))
push(assistant(U(5), U(4), 'gpt-fixture', 'openai_pm-1', { type: 'tool_use', id: 'call_A', name: 'Read', input: { file_path: '/tmp/a' } }))
push(assistant(U(6), U(5), 'gpt-fixture', 'openai_pm-1', { type: 'tool_use', id: 'call_B', name: 'Read', input: { file_path: '/tmp/b' } }))
push(assistant(U(7), U(6), 'gpt-fixture', 'openai_pm-1', { type: 'tool_use', id: 'call_C', name: 'Glob', input: { pattern: '*' } }))
push(toolResult(U(8), U(7), 'call_A'))
push(toolResult(U(9), U(8), 'call_B'))
push(toolResult(U(10), U(9), 'call_C'))
push(assistant(U(11), U(10), 'opus-fixture', 'msg_pm-2', { type: 'thinking', thinking: 'tests next', signature: '' }))
push(assistant(U(12), U(11), 'opus-fixture', 'msg_pm-2', { type: 'text', text: 'Global classes registered cleanly. Running the logic tests.', citations: null }))
push(assistant(U(13), U(12), 'opus-fixture', 'msg_pm-2', { type: 'tool_use', id: 'toolu_D', name: 'Bash', input: { command: 'run tests' } }))
push(assistant(U(13), U(12), 'opus-fixture', 'msg_pm-2', { type: 'tool_use', id: 'toolu_D', name: 'Bash', input: { command: 'run tests' } }, 465))
push(toolResult(U(14), U(13), 'toolu_D'))
push(assistant(U(15), U(14), 'opus-fixture', 'msg_pm-3', { type: 'text', text: 'All sixteen pass.', citations: null }))

const home = realpathSync(mkdtempSync(join(tmpdir(), 'single-paint-')))
const file = join(home, `${SID}.jsonl`)
writeFileSync(file, lines.join('\n') + '\n')

const EXPECTED_TEXTS = [
  'Reading the project first.',
  'Global classes registered cleanly. Running the logic tests.',
  'All sixteen pass.',
]
const EXPECTED_CALLS = ['call_A', 'call_B', 'call_C', 'toolu_D']

function textCounts(arr: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of arr as Array<{ type?: string; message?: { content?: unknown } }>) {
    if (m?.type !== 'assistant') continue
    const c = m.message?.content
    const text = Array.isArray(c)
      ? c.filter((b: { type?: string }) => b?.type === 'text').map((b: { text?: string }) => b.text ?? '').join('')
      : typeof c === 'string'
        ? c
        : ''
    const trimmed = text.trim()
    if (trimmed) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
  return counts
}
function callCounts(arr: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of arr as Array<{ type?: string; message?: { content?: unknown } }>) {
    const c = m?.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c as Array<{ type?: string; id?: string }>) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') counts.set(b.id, (counts.get(b.id) ?? 0) + 1)
    }
  }
  return counts
}
function assertOnce(stage: string, arr: readonly unknown[]): void {
  const texts = textCounts(arr)
  for (const expected of EXPECTED_TEXTS) {
    t(`${stage}: ${JSON.stringify(expected.slice(0, 34))} paints exactly once`, texts.get(expected) === 1, `count=${texts.get(expected) ?? 0}`)
  }
  const over = [...texts].filter(([, n]) => n > 1)
  t(`${stage}: no assistant text stands twice`, over.length === 0, JSON.stringify(over))
  const uuids = new Map<string, number>()
  for (const m of arr as Array<{ uuid?: string }>) if (m?.uuid) uuids.set(m.uuid, (uuids.get(m.uuid) ?? 0) + 1)
  const du = [...uuids].filter(([, n]) => n > 1)
  t(`${stage}: no uuid stands twice`, du.length === 0, JSON.stringify(du))
}

const loaded = await loadTranscriptFile(file)
t('§1 the update pair folds last-wins (one entry per record id)', [...loaded.messages.values()].length === lines.length - 2, `${[...loaded.messages.values()].length} vs ${lines.length - 2} (header dropped, update folded)`)

const leaf = findLatestMessage(
  loaded.messages.values(),
  (msg: { uuid: string; type?: string }) => loaded.leafUuids.has(msg.uuid) && (msg.type === 'user' || msg.type === 'assistant'),
)
t('§2 a leaf resolves', leaf !== undefined && leaf !== null)
const chain = buildConversationChain(loaded.messages, leaf!)
assertOnce('§2 chain', chain)
const live = deserializeLiveMessages(chain as never)
assertOnce('§2 deserialized', live)
const normalized = normalizeMessages(live as never)
assertOnce('§2 normalized', normalized)

const tools = getAllBaseTools()
const grouped = applyGrouping(normalized as never, tools as never, false).messages
assertOnce('§3 grouped', grouped)
const receipts = injectTurnReceipts(grouped as never)
assertOnce('§3 receipts', receipts)
const collapsed = collapseReadSearchGroups(receipts as never, tools as never, new Set())
assertOnce('§3 collapsed', collapsed)

{
  const calls = callCounts(normalized)
  for (const id of EXPECTED_CALLS) {
    t(`§4 tool use ${id} stands exactly once`, calls.get(id) === 1, `count=${calls.get(id) ?? 0}`)
  }
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? 'TRANSCRIPT SINGLE PAINT: ALL PASS' : 'FAILURES')
process.exit(failures)

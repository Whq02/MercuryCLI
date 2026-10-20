#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'single-envelope-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { recordTranscript, flushSessionStorage } = await import(join(ROOT, 'src/utils/sessionStorage/writer.ts'))
const { createUserMessage, createAssistantMessage, createSystemMessage } = await import(join(ROOT, 'src/utils/messages.ts'))
const { createAttachmentMessage } = await import(join(ROOT, 'src/utils/attachments/orchestrator.ts'))
const { getSessionId } = await import(join(ROOT, 'src/bootstrap/state.ts'))
const loading = await import(join(ROOT, 'src/utils/sessionStorage/loading.ts'))
const chain = await import(join(ROOT, 'src/utils/sessionStorage/chain.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
type Row = { uuid: string }

console.log('a single-envelope response: the attachments written after it stay on the chain its tool result continues')

const ask = createUserMessage({ content: 'read the file' }) as Row
const envelope = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_single', name: 'Read', input: { file_path: '/x' } }] }) as Row
await recordTranscript([ask, envelope] as never)
const boundRecord = createAttachmentMessage({ type: 'bound_prefix', boundKey: 'owner|conv|claude-sonnet-5', rosterEnabled: true, roster: [{ name: 'Read', definition: {} }], sections: [{ id: 'core', hash: 'a' }], systemContext: {} } as never) as Row
const deadMarks = createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: 'msg_1', blockIndex: 0 }] } as never) as Row
await recordTranscript([boundRecord, deadMarks] as never)
const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_single', content: 'the file' }], sourceToolAssistantUUID: envelope.uuid as never }) as Row
await recordTranscript([result] as never)
const reply = createAssistantMessage({ content: [{ type: 'text', text: 'done' }] }) as Row
await recordTranscript([reply] as never)
await flushSessionStorage()

const home = process.env.MERCURY_CONFIG_DIR!
const files: string[] = []
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.jsonl')) files.push(p)
  }
}
walk(home)
const sessionFile = files.find(f => f.includes(getSessionId()))
check('the session file stands', sessionFile !== undefined, files.join(', '))

const parents = new Map<string, string | null>()
for (const line of readFileSync(sessionFile!, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  try {
    const record = JSON.parse(line) as { recordId?: string; parentId?: string | null; payload?: { fields?: { uuid?: string; parentUuid?: string | null } } }
    const uuid = record.payload?.fields?.uuid ?? record.recordId
    if (typeof uuid === 'string') parents.set(uuid, record.payload?.fields?.parentUuid ?? record.parentId ?? null)
  } catch {}
}
check('the bound-prefix record chains onto the envelope', parents.get(boundRecord.uuid) === envelope.uuid, `parent=${parents.get(boundRecord.uuid)}`)
check('the dead-thinking marks chain onto the record', parents.get(deadMarks.uuid) === boundRecord.uuid, `parent=${parents.get(deadMarks.uuid)}`)
check(
  'THE LAW: the tool result continues the chain through the attachments written after its envelope, never beside them',
  parents.get(result.uuid) === deadMarks.uuid,
  `result.parent=${parents.get(result.uuid)} (a side leaf points it at the envelope ${envelope.uuid.slice(0, 8)}…)`,
)

const fold = await loading.loadTranscriptFile(sessionFile!)
const leaf = chain.findLatestMessage(fold.messages.values(), (m: { isSidechain?: boolean }) => !m.isSidechain)
const loaded = leaf === undefined ? [] : (chain.buildConversationChain(fold.messages, leaf) as Row[])
const ids = new Set(loaded.map(r => r.uuid))
check('a later process loads the record and the marks on the conversation chain (nothing hangs on a side leaf)', ids.has(boundRecord.uuid) && ids.has(deadMarks.uuid) && ids.has(result.uuid) && ids.has(reply.uuid), loaded.map(r => r.uuid.slice(0, 8)).join(' → '))
check('the chain reads ask → envelope → record → marks → result → reply', loaded.map(r => r.uuid).join(',') === [ask, envelope, boundRecord, deadMarks, result, reply].map(r => r.uuid).join(','), loaded.map(r => r.uuid.slice(0, 8)).join(' → '))

const ask2 = createUserMessage({ content: 'and now with a word between' }) as Row
const envelope2 = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_second', name: 'Read', input: { file_path: '/y' } }] }) as Row
await recordTranscript([ask2, envelope2] as never)
const note = createSystemMessage('a system note after the envelope', 'info') as Row
await recordTranscript([note] as never)
const interjection = createUserMessage({ content: 'the operator typed while the tool ran' }) as Row
await recordTranscript([interjection] as never)
const result2 = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_second', content: 'the second file' }], sourceToolAssistantUUID: envelope2.uuid as never }) as Row
await recordTranscript([result2] as never)
await flushSessionStorage()
parents.clear()
for (const line of readFileSync(sessionFile!, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  try {
    const record = JSON.parse(line) as { recordId?: string; parentId?: string | null; payload?: { fields?: { uuid?: string; parentUuid?: string | null } } }
    const uuid = record.payload?.fields?.uuid ?? record.recordId
    if (typeof uuid === 'string') parents.set(uuid, record.payload?.fields?.parentUuid ?? record.parentId ?? null)
  } catch {}
}
check('a user row written between the envelope and its result keeps the carve-out: the result parents to the envelope (the wire never sees a word between a call and its result)', parents.get(result2.uuid) === envelope2.uuid, `result2.parent=${parents.get(result2.uuid)}`)

console.log(failures === 0 ? '\n ✅ single-envelope attachments stay on the chain' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

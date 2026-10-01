#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'parallel-batch-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'parallel-batch-'))
process.chdir(scratch)

const { encodeTranscriptLine } = await import(join(ROOT, 'src/utils/sessionStorage/vnext.ts'))
const { loadConversationForResume } = await import(join(ROOT, 'src/utils/conversationRecovery.ts'))
const { loadTranscriptFile, pruneRecordBranchesBeforeParse } = await import(join(ROOT, 'src/utils/sessionStorage/loading.ts'))
const { buildConversationChain } = await import(join(ROOT, 'src/utils/sessionStorage/chain.ts'))
const { _resetTranscriptReaderForTesting } = await import(join(ROOT, 'src/utils/sessionStorage/transcriptReader.ts'))
const { SKIP_PRECOMPACT_THRESHOLD } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

type Row = Record<string, unknown>
const sessionId = 'e0040000-1111-4000-8000-000000000001'
let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
const stamp = (): string => new Date(Date.parse('2026-10-01T19:49:00.000Z') + n * 1000).toISOString()
const base = (uuid: string, parentUuid: string | null): Row => ({ uuid, parentUuid, isSidechain: false, cwd: scratch, sessionId, version: '1.0.0-beta.26', timestamp: stamp() })
const userText = (uuid: string, parent: string | null, text: string): Row => ({ ...base(uuid, parent), type: 'user', message: { role: 'user', content: text } })
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const toolUseRow = (uuid: string, parent: string | null, messageId: string, callId: string, path: string): Row => ({
  ...base(uuid, parent),
  type: 'assistant',
  message: { id: messageId, role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: callId, name: 'Read', input: { file_path: path } }], usage },
})
const textRow = (uuid: string, parent: string | null, messageId: string, text: string): Row => ({
  ...base(uuid, parent),
  type: 'assistant',
  message: { id: messageId, role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage },
})
const imageBytes = (seed: number, bytes: number): string => Buffer.alloc(bytes, seed & 0xff).toString('base64')
const toolResultRow = (uuid: string, assistantUuid: string, callId: string, seed: number, bytes: number): Row => ({
  ...base(uuid, assistantUuid),
  type: 'user',
  sourceToolAssistantUUID: assistantUuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBytes(seed, bytes) } }, { type: 'text', text: `[Image ${seed} of 3: 1600x900]` }] }] },
})

const FAT = 2_200_000
const rows: Row[] = []
const u0 = uid()
rows.push(userText(u0, null, 'hello, please just say ok'))
const a0 = uid()
rows.push(textRow(a0, u0, 'msg_first', 'ok'))
const u1 = uid()
rows.push(userText(u1, a0, 'Use the Read tool on each of these 3 image files — one Read call per file, all in one step'))
const tools = [1, 2, 3].map(k => ({ asst: uid(), call: `toolu_read_${k}`, path: `/shots/shot0${k}.png` }))
let parent: string = u1
for (const t of tools) {
  rows.push(toolUseRow(t.asst, parent, 'msg_batch', t.call, t.path))
  parent = t.asst
}
const results = tools.map((t, i) => ({ uuid: uid(), asst: t.asst, call: t.call, seed: i + 1 }))
for (const r of results) rows.push(toolResultRow(r.uuid, r.asst, r.call, r.seed, FAT))
const a2 = uid()
rows.push(textRow(a2, results[results.length - 1]!.uuid, 'msg_done', 'DONE 3'))
const u2 = uid()
rows.push(userText(u2, a2, 'what now?'))
const dead = { prompt: uid(), asst: uid(), fat: uid() }
rows.push(userText(dead.prompt, a2, 'a prompt the operator rewound away'))
rows.push(toolUseRow(dead.asst, dead.prompt, 'msg_dead', 'toolu_dead', '/shots/dead.png'))
rows.push(toolResultRow(dead.fat, dead.asst, 'toolu_dead', 9, 5 * FAT))
const a3 = uid()
rows.push(textRow(a3, u2, 'msg_last', 'Nothing is pending. I read all 3 images.'))
const liveUuids = [u0, a0, u1, ...tools.map(t => t.asst), ...results.map(r => r.uuid), a2, u2, a3]
const deadUuids = [dead.prompt, dead.asst, dead.fat]

const path = join(scratch, `${sessionId}.jsonl`)
writeFileSync(path, rows.map(r => encodeTranscriptLine(path, r).line).join(''))
const raw = readFileSync(path)
const rawHash = sha(raw)

section('§A the on-disk shape a parallel batch has (the writer\'s own parent law)')
{
  check(`the file crosses the big-file gate (${raw.length} > ${SKIP_PRECOMPACT_THRESHOLD})`, raw.length > SKIP_PRECOMPACT_THRESHOLD, String(raw.length))
  const full = await loadTranscriptFile(path, { keepAllLeaves: true })
  const leaf = full.messages.get(a3 as never)!
  const chain = buildConversationChain(full.messages, leaf)
  const walk = new Set<string>()
  for (let cur: typeof leaf | undefined = leaf; cur !== undefined; cur = cur.parentUuid ? full.messages.get(cur.parentUuid) : undefined) walk.add(cur.uuid)
  check('on the single-parent walk every tool_use is an ancestor of the leaf and only the LAST tool_result is', tools.every(t => walk.has(t.asst)) && results.filter(r => walk.has(r.uuid)).length === 1 && walk.has(results[2]!.uuid))
  check('the full load\'s chain builder recovers all three results (the <5MB road)', results.every(r => chain.some(m => m.uuid === r.uuid)) && !deadUuids.some(u => chain.some(m => m.uuid === u)))
}

section('§B the pruner keeps what the chain builder recovers, and nothing dead')
{
  const pruned = pruneRecordBranchesBeforeParse(raw)
  const prunedText = pruned.toString('utf8')
  check('the buffer was pruned (the dead branch and nothing live is gone)', pruned.length < raw.length && liveUuids.every(u => prunedText.includes(u)), `${pruned.length}/${raw.length}`)
  check('THE FIELD DEFECT: the two off-chain tool results of the batch survive the prune', results.every(r => prunedText.includes(r.uuid)), results.filter(r => !prunedText.includes(r.uuid)).map(r => r.uuid).join(','))
  check('the rewound branch is still pruned whole (its prompt, its assistant, its fat result)', !deadUuids.some(u => prunedText.includes(u)), deadUuids.filter(u => prunedText.includes(u)).join(','))
}

section('§C the resume road (the one the headless --resume and the chat take) rebuilds the conversation with EVERY result of the batch')
{
  _resetTranscriptReaderForTesting()
  const loaded = await loadConversationForResume(sessionId, path)
  check('the session resumes (a cold read, as a fresh process makes it)', loaded !== null)
  const messages = (loaded?.messages ?? []) as Array<{ uuid?: string; type?: string; message?: { content?: unknown } }>
  const toolResults = messages.flatMap(m => (m.type === 'user' && Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type?: string; tool_use_id?: string }>).filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : []))
  check('all three tool results are in the rebuilt conversation (base: one — the last ancestor only)', toolResults.length === 3 && tools.every(t => toolResults.includes(t.call)), `tool_results on resume: ${toolResults.length} (${toolResults.join(',')})`)
  const toolUses = messages.flatMap(m => (m.type === 'assistant' && Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type?: string; id?: string }>).filter(b => b.type === 'tool_use').map(b => b.id) : []))
  check('the API\'s rule holds: every tool_use of the turn has its tool_result', toolUses.length === 3 && toolUses.every(id => toolResults.includes(id as string)))
  const order = messages.map(m => m.uuid)
  const lastUse = Math.max(...tools.map(t => order.indexOf(t.asst)))
  const firstResult = Math.min(...results.map(r => order.indexOf(r.uuid)))
  check('the three results follow the three tool_uses as one contiguous batch', firstResult > lastUse && results.every(r => order.indexOf(r.uuid) > lastUse) && order.indexOf(a2) > Math.max(...results.map(r => order.indexOf(r.uuid))))
  check('no dead row reaches the conversation and the live tail is intact', !deadUuids.some(u => order.includes(u)) && order[order.length - 1] === a3)
  _resetTranscriptReaderForTesting()
  const full = await loadTranscriptFile(path, { keepAllLeaves: true })
  const fullChain = buildConversationChain(full.messages, full.messages.get(a3 as never)!).map(m => m.uuid)
  check('the pruned resume equals the full-load chain, uuid for uuid', JSON.stringify(fullChain) === JSON.stringify(order), `full=${fullChain.length} pruned=${order.length}`)
}

section('§D the on-disk shape is untouched')
{
  check('the session file is byte-identical after the resume (the reader fixed nothing on disk)', sha(readFileSync(path)) === rawHash)
  const headless = readFileSync(join(ROOT, 'src/cli/headless/resume.ts'), 'utf8')
  check('the headless --resume door loads through the same resume road', headless.includes('loadConversationForResume('))
}

console.log(failures === 0 ? '\n ✅ PARALLEL BATCH RESUME PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

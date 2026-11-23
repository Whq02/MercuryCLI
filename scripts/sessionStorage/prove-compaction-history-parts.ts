#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'
import type { Entry } from '../../src/sessions/transcripts/transcriptEntries.ts'

const compact = (id: string, sid: string, segment?: { headUuid: string; tailUuid: string; anchorUuid: string }) => ({
  type: 'system', subtype: 'compact_boundary', sessionId: sid, uuid: id, parentUuid: null, timestamp: new Date().toISOString(), content: 'Conversation compacted',
  compactMetadata: { trigger: 'manual', preTokens: 10000, ...(segment ? { preservedSegment: segment } : {}) },
})
async function land(path: string, entry: Record<string, unknown>): Promise<void> {
  const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
  const queue = new QueuePart()
  const landed = queue.enqueueWrite(path, entry as Entry)
  await queue.flush()
  await landed
}

if (process.argv[2] === '--fault-child') {
  await land(process.argv[3]!, compact(process.argv[4]!, process.argv[5]!))
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'history-parts-')))
const cwd = join(scratch, 'work')
seedScratchHome(scratch, cwd)
process.env.MERCURY_CONFIG_DIR = scratch
const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const { historyHead, historyLines, sealedFile } = await import('../../src/sessions/transcripts/historyParts.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { transcriptLineBytes, transcriptReaderCensus } = await import('../../src/sessions/transcripts/transcriptBytes.ts')
const { readTranscriptRecordIds } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { createBranchSession } = await import('../../src/sessions/branches/branchManifest.ts')
const { jsonlConciseRows } = await import('../../src/integrations/resources/adapters/transcript.ts')
const { openWorkerTranscript } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const { recordToEntry } = await import('../../src/sessions/fabric/entryCodec.ts')
const { buildSessionDeleteOffer, operatorPruneTranscripts } = await import('../../src/daemon/switchboard/transcriptPruneDoor.ts')
const stamp = (iter: Iterable<Buffer | string>) => { const hash = createHash('sha256'); for (const row of iter) hash.update(row); return hash.digest('hex') }
const project = getProjectDir(cwd)
mkdirSync(project, { recursive: true })
const sid = randomUUID(), file = join(project, `${sid}.jsonl`)
const append = (path: string, entry: Record<string, unknown>) => appendFileSync(path, encodeTranscriptLine(path, entry).line)
const user = (uuid: string, text: string, parentUuid: string | null) => ({ type: 'user', uuid, parentUuid, sessionId: sid, cwd, timestamp: new Date().toISOString(), isSidechain: false, message: { role: 'user', content: text } })
const api = await startScriptedFixture(() => [{ type: 'text', text: 'History proof answered.' }])
const legacyAt = process.argv.indexOf('--legacy-dist')
const dist = legacyAt > 0 ? process.argv[legacyAt + 1]! : DIST
const env = { ...childEnv(scratch, Number(new URL(api.base).port)), HOME: scratch }
async function turn(kind: '--session-id' | '--resume', prompt: string): Promise<void> {
  const runner = hostRunner({ node: NODE, dist, env, home: scratch, cwd, argv: [kind, sid, '--model', MODEL, '--mode', 'sovereign', '--sovereign'] })
  try {
    await runner.initialize()
    await runner.prompt(prompt)
    const outcome = await runner.waitFor('runner accepted and answered on this session', row => row.type === 'outcome')
    assert.equal(outcome.status, 'completed', `the ${kind} runner must finish the prompt`)
    assert.equal(outcome.answer, 'History proof answered.', `the ${kind} runner must receive the loopback answer`)
    assert.equal(outcome.session_id, sid, 'a resumed prompt must stay in its original session')
  } finally { await runner.stop() }
}

try {
  await turn('--session-id', 'Original history prompt.')
  assert(existsSync(file), 'the existing writer must publish a one-file history in this project')
  await turn('--resume', 'Continue the original session.')
  const plain = join(project, 'one-file-copy.jsonl')
  const oldId = randomUUID()
  append(file, user(oldId, 'Named point in the old history.', null))
  const realSize = process.argv.includes('--real-size')
  const payload = 'x'.repeat(realSize ? 9_000_000 : 8192)
  for (let i = 0; i < (realSize ? 63 : 10); i++) {
    append(file, { type: 'attribution-snapshot', sessionId: sid, messageId: oldId, surface: 'cli', fileStates: { 'proof.ts': { contentHash: payload, mtime: 0, mercuryContribution: 1 } }, promptCount: 1, promptCountAtLastCommit: 0, permissionPromptCount: 0, permissionPromptCountAtLastCommit: 0, escapeCount: 0, escapeCountAtLastCommit: 0 })
  }
  append(file, { type: 'custom-title', sessionId: sid, customTitle: 'Kept title' })
  writeFileSync(plain, '')
  for (const line of transcriptLineBytes(file)) appendFileSync(plain, line)
  const oldBytes = statSync(file).size
  const initial = stamp(transcriptLineBytes(plain))
  const priorIds = transcriptReaderCensus.bytesRead
  const known = await readTranscriptRecordIds(file)
  const coldBytes = transcriptReaderCensus.bytesRead - priorIds
  const beforeOrdinal = [...jsonlConciseRows(plain)]
  const fork = randomUUID()
  await land(file, compact(fork, sid))
  const head = historyHead(file), sealed = sealedFile(file, oldBytes)
  assert.equal(head.before, oldBytes, 'the first compact must seal the complete original file')
  assert.equal(stamp(transcriptLineBytes(sealed)), initial, 'sealed bytes must be exactly the original bytes')
  const delta = [...historyLines(file, head.before)]
  assert.equal(delta.length, 1, 'the logical suffix must contain the boundary once, not a copy of its prelude')
  appendFileSync(plain, delta[0]!)
  const kept = randomUUID()
  const prompt = user(kept, 'First prompt in the new part.', fork)
  append(file, prompt)
  assert.deepEqual(jsonlConciseRows(file).slice(0, beforeOrdinal.length), beforeOrdinal, 'Inspect must include earlier messages in chronological order')
  const coldAfter = transcriptReaderCensus.bytesRead
  const ids = await readTranscriptRecordIds(file)
  const splitBytes = transcriptReaderCensus.bytesRead - coldAfter
  assert([...known].every(id => ids.has(id)) && ids.has(fork) && ids.has(kept), 'cold dedup must include sealed and live IDs')
  assert(splitBytes < coldBytes, `part indexes must replace the old data pass: ${splitBytes} vs ${coldBytes}`)
  console.log(`Cold ID pass: ${coldBytes} → ${splitBytes} bytes; live file ${oldBytes} → ${statSync(file).size} bytes`)
  const count = { physical: 0, logical: 0 }
  for (const line of transcriptLineBytes(plain)) if (line.length) count.physical++
  for (const line of historyLines(file)) if (line.length) count.logical++
  assert.equal(count.logical, count.physical + 1, 'archived and live usage/ordinal walks must not repeat the carry')
  const branch = createBranchSession({ sourceTranscriptPath: file, forkOrdinal: count.physical - 1, boundaryKind: 'rewind', providerOrigin: MODEL, cwd })
  assert(branch.ok, 'rewind must be able to copy a point in the sealed file')
  assert.equal(stamp(historyLines(branch.branchTranscriptPath, 0, oldBytes)), initial, 'the old branch prefix must still be byte-identical')
  const partial = randomUUID(), summary = randomUUID()
  await land(file, compact(partial, sid, { headUuid: kept, tailUuid: kept, anchorUuid: summary }))
  append(file, { ...user(summary, 'Compact summary.', partial), isCompactSummary: true })
  const folded = await loadTranscriptFile(file, { throwOnError: true })
  assert(folded.messages.has(kept) && folded.customTitles.get(sid) === 'Kept title', 'a partial fold must retain its named segment and session metadata')
  let picked: string[] = []
  openWorkerTranscript(file, records => { picked = Array.from(records, r => String(recordToEntry(r as never).uuid)) }, 2)
  assert.deepEqual(picked, [partial, summary], 'the capped mirror must return the same two most recent rows without showing the carry twice')
  const crossed = join(project, 'crossed.jsonl'), twin = join(project, 'crossed-one-file.jsonl')
  const q = randomUUID(), tool = randomUUID(), result = randomUUID(), last = randomUUID()
  const b1 = randomUUID(), b2 = randomUUID(), s1 = randomUUID(), s2 = randomUUID()
  append(crossed, user(q, 'Keep my words across both folds.', null))
  append(crossed, { ...user(tool, '', q), type: 'assistant', message: { id: 'msg_crossed', role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: 'call_crossed', name: 'Read', input: { file_path: 'note.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } } })
  await land(crossed, compact(b1, sid, { headUuid: q, tailUuid: tool, anchorUuid: s1 }))
  append(crossed, { ...user(s1, 'First compact summary.', b1), isCompactSummary: true })
  append(crossed, { ...user(result, '', s1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_crossed', content: 'The saved result.' }] } })
  await land(crossed, compact(b2, sid, { headUuid: q, tailUuid: result, anchorUuid: s2 }))
  append(crossed, { ...user(s2, 'Second compact summary.', b2), isCompactSummary: true })
  append(crossed, user(last, 'Continue from the result.', s2))
  writeFileSync(twin, '', { flag: 'wx' })
  for (const line of historyLines(crossed)) appendFileSync(twin, line)
  const { buildConversationChain, buildScreenConversation, findLatestMessage } = await import('../../src/sessions/transcripts/chain.ts')
  async function chains(path: string) {
    const loaded = await loadTranscriptFile(path, { throwOnError: true })
    const leaf = findLatestMessage(loaded.messages.values(), row => loaded.leafUuids.has(row.uuid))
    assert(leaf, 'the crossed folds must have a leaf to resume')
    return { model: buildConversationChain(loaded.messages, leaf).map(m => m.uuid), screen: buildScreenConversation(loaded.messages).map(m => m.uuid) }
  }
  const original = await chains(twin)
  for (const id of [q, tool, result, last]) assert(original.model.includes(id) && original.screen.includes(id), `the one-file control must retain ${id} in both views`)
  assert.deepEqual(await chains(crossed), original, 'both folds must preserve the parent links of the prompt, tool call and result')
  await turn('--resume', 'Read the part and answer.')
  assert.equal(stamp(transcriptLineBytes(sealed)), initial, 'a previous build may append to the live head, never to a sealed part')
  for (const phase of ['seal-part', 'rename', 'flush-dir']) {
    const id = randomUUID(), path = join(project, `${id}.jsonl`), boundary = randomUUID()
    append(path, { ...user(randomUUID(), 'Survives a killed writer.', null), sessionId: id })
    const saved = stamp(transcriptLineBytes(path))
    const size = statSync(path).size
    const killed = spawnSync(process.execPath, [import.meta.path, '--fault-child', path, boundary, id], { env: { ...process.env, MERCURY_CONFIG_DIR: scratch, MERCURY_DURABLE_FSYNC: '1', MERCURY_FAULT_INJECT: `${phase}@${id}.jsonl:kill` }, encoding: 'utf8', timeout: 30_000 })
    assert(killed.signal === 'SIGKILL' || (process.platform === 'win32' && killed.status !== 0), `the scratch writer must be killed at ${phase}: ${killed.stderr}`)
    assert.equal(stamp(historyLines(path, 0, size)), saved, `the old prefix must survive a kill at ${phase}`)
    await land(path, compact(boundary, id))
    assert.equal([...historyLines(path, size)].length, 1, `retry at ${phase} must leave exactly one boundary`)
  }
  const offer = buildSessionDeleteOffer({ fullPath: file, sessionId: sid, fileSize: statSync(file).size, modified: new Date() }, { scopeLabel: 'history proof', liveSessionIds: new Set() })
  assert(offer, 'deletion of the closed scratch session must have an offer')
  const deleted = await operatorPruneTranscripts(offer)
  assert.equal(deleted.failed, 0, 'part-aware deletion must succeed')
  assert(!existsSync(file) && !existsSync(sealed) && !existsSync(`${sealed}.index`), 'deletion must remove the live history and its sealed data and indexes')
  console.log('History parts: one-file resume, full and partial fold, chronological counts, old rewind, bounded mirror, previous runner, three killed writers, deletion')
} finally {
  await api.close()
  rmSync(scratch, { recursive: true, force: true })
}

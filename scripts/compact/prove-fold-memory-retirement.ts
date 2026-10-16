;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-memory-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { compactConversation, buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const retirement = await import('../../src/services/compact/foldRetirement.ts').catch(() => null)
const foldMemoryStoredText = retirement?.foldMemoryStoredText ?? (() => '')
const foldMemoryWitness = retirement?.foldMemoryWitness ?? (() => '')
const readBackStoredRow = retirement?.readBackStoredRow ?? (() => null)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { acceptUserRequest, noteRunEvent } = await import('../../src/services/run/runCoordinator.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { currentBufferPath, pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { memoryPointerForId, searchPointers } = await import('../../src/mneme/mnemePointers.ts')
const { recallQuery, readMemoryRecord } = await import('../../src/mneme/memoryVerbs.ts')
const { strikePendingRow } = await import('../../src/mneme/mnemeCorrect.ts')
const { APIUserAbortError } = await import('../../src/services/api/sdkErrors.ts')
const { groupMessagesByApiRound } = await import('../../src/services/compact/grouping.ts')

let checks = 0
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

let clock = Date.UTC(2026, 9, 16)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content } }) as Message
function rounds(count: number): Message[] {
  const rows: Message[] = []
  for (let index = 0; index < count; index++) {
    const id = randomUUID()
    rows.push(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/source${index}.ts` } }]))
    rows.push(user([{ type: 'tool_result', tool_use_id: id, content: `line ${index} `.repeat(400) }]))
  }
  return rows
}
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'The compaction road was rebuilt on the measurement. Row six retires the run state to project memory with a pointer the next epoch can read back.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const dir = mnemeLibraryDir()
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'fold-memory-proof', lane: 'main' })
const context = (overrides: Record<string, unknown> = {}) => ({
  owner,
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(20),
  loadedNestedMemoryPaths: new Set<string>(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
  ...overrides,
}) as never
const fold = (messages: Message[], ctx = context()) =>
  compactConversation(messages, ctx, { systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: [] }, true)
const envelopeOf = (result: Awaited<ReturnType<typeof fold>>) => result.boundaryMarker.compactMetadata.memory
const summaryOf = (result: Awaited<ReturnType<typeof fold>>) => String(result.summaryMessages[0]?.message.content)

try {
  const always = 'The release gate always runs before a fold lands on the working branch.'
  acceptUserRequest(owner, { objective: always, rootMessageId: null })
  noteRunEvent(owner, { type: 'substantive', at: Date.now(), reason: 'implementation began' })
  noteRunEvent(owner, { type: 'task-transition', at: Date.now(), taskId: 'row-6', title: 'Row six: memory-backed retirement', state: 'in-progress' })
  noteRunEvent(owner, { type: 'next-action', at: Date.now(), action: 'Prove the pointer read-back and a later Recall.' })

  const firstInput = [user('Rebuild the compaction road on the measurement.'), ...rounds(14)]
  const firstRounds = groupMessagesByApiRound(firstInput).length
  const first = await fold(firstInput)
  const envelope = envelopeOf(first)
  check('the boundary carries the fold memory envelope', envelope !== undefined)
  assert.ok(envelope)
  check('the envelope is committed with a shared memory pointer', envelope.state === 'committed' && 'pointer' in envelope && envelope.pointer.id.startsWith('pending:'), envelope.state)
  assert.equal(envelope.state, 'committed')
  const id = envelope.pointer.id
  check('the pointer keeps the shared identity {id,title,kind,footnotes} and names the fold as its source', envelope.pointer.kind === 'fact' && typeof envelope.pointer.title === 'string' && typeof envelope.pointer.footnotes === 'object' && envelope.pointer.source?.kind === 'pending' && envelope.pointer.source.source === `fold s:${envelope.pointer.source.source.slice(7, 15)} e:${envelope.epoch}`, JSON.stringify(envelope.pointer))
  check('the envelope names the fold epoch, a session ordinal field and the source record range', envelope.epoch === 1 && envelope.sessionOrdinal === null && envelope.sourceRange.firstTurn === 1 && envelope.sourceRange.lastTurn === firstRounds && envelope.sourceRange.firstRecordId === firstInput[0]!.uuid && envelope.sourceRange.lastRecordId === firstInput.at(-1)!.uuid, JSON.stringify(envelope.sourceRange))
  const stored = readBackStoredRow(id, dir)
  check('the stored row read back whole is the selected item, byte for byte', stored !== null && envelope.item !== null && stored.text === foldMemoryStoredText(envelope.item), stored?.text.slice(0, 80))
  check('the content witness is the sha256 of that stored text', stored !== null && envelope.contentWitness.algorithm === 'sha256' && envelope.contentWitness.digest === foldMemoryWitness(stored.text))
  check('the item carries the run objective, the deliverable with its state and the next action', envelope.item !== null && envelope.item.content.includes(always) && envelope.item.content.includes('Row six: memory-backed retirement [in-progress]') && envelope.item.content.includes('Prove the pointer read-back and a later Recall.'), envelope.item?.content)
  check('the item context names the epoch and the record range, not the content', envelope.item !== null && envelope.item.context.startsWith('context epoch 1; source records ') && envelope.item.context.includes(`rounds 1–${firstRounds})`), envelope.item?.context)
  check('the row is not pinned and the shelf holds zero pins', stored?.pin === false && readPins(dir).length === 0)
  const pointer = memoryPointerForId(id, { dir })
  check('the shared builder resolves the advertised pointer to the same identity', pointer !== null && pointer.id === id && pointer.kind === envelope.pointer.kind && pointer.title === envelope.pointer.title, JSON.stringify(pointer))
  const record = readMemoryRecord(id, dir)
  check('the public read returns the record whole', record.found && typeof record.content === 'string' && stored !== null && record.content.startsWith(stored.text), record.content?.slice(0, 60))
  const recall = recallQuery('release gate fold working branch', { dir })
  check('a later Recall finds the folded fact', recall.hits.some(hit => hit.id === id), JSON.stringify(recall.hits.map(hit => hit.id)))
  check('a later pointer search offers it', searchPointers('release gate fold', { dir }).pointers.some(p => p.id === id))
  const summary = summaryOf(first)
  check('the summary names what it stored and where', summary.includes('## Moved to memory') && summary.includes(`[${id}] fact`) && summary.includes('stored in project memory, read back whole') && summary.includes(`Recall read:"${id}"`))
  check('the summary points the rest at the transcript by record range', summary.includes(`source records ${envelope.sourceRange.firstRecordId.slice(0, 8)}…${envelope.sourceRange.lastRecordId.slice(0, 8)} (rounds 1–${firstRounds})`))
  check('exactly one row was written', pendingRows(dir).length === 1)

  const secondInput = [...buildPostCompactMessages(first), ...rounds(3)]
  const again = await fold(secondInput)
  const second = envelopeOf(again)
  check('a repeated fold with the same run state advertises the same pointer without a second copy', second?.state === 'committed' && 'pointer' in second && second.pointer.id === id && pendingRows(dir).length === 1, `${second?.state} rows=${pendingRows(dir).length}`)
  check('the repeated fold keeps the first row\'s witness and context, so its receipt is the stored record', second?.contentWitness.digest === envelope.contentWitness.digest && second.item?.context === envelope.item?.context)
  check('the repeated fold continues the source-turn range and epoch', second?.epoch === 2 && second.sourceRange.firstTurn === firstRounds + 1 && second.sourceRange.lastTurn === firstRounds + groupMessagesByApiRound(secondInput).length, JSON.stringify(second?.sourceRange))

  acceptUserRequest(owner, { objective: always.replace('always runs', 'never runs'), rootMessageId: null })
  const conflicted = await fold([...buildPostCompactMessages(again), ...rounds(3)])
  const conflict = envelopeOf(conflicted)
  check('a contradicting run state is refused by the retention guard and advertises no pointer', conflict?.state === 'failed' && 'reason' in conflict && conflict.reason.includes('conflicts with a pending fact') && !('pointer' in conflict), conflict?.state === 'failed' ? conflict.reason : conflict?.state)
  check('nothing was written for the conflict and the fold still landed', pendingRows(dir).length === 1 && conflicted.summaryMessages.length === 1)
  check('the summary says nothing moved and keeps the unsaved item visible in the boundary', summaryOf(conflicted).includes('Nothing moved to memory: ') && summaryOf(conflicted).includes('conflicts with a pending fact') && conflict?.item !== null)

  const fakeKey = ['sk-ant-api03', 'a'.repeat(95)].join('-')
  acceptUserRequest(owner, { objective: `Rotate the key ${fakeKey} before the release.`, rootMessageId: null })
  const secret = envelopeOf(await fold([user('Rotate the key.'), ...rounds(14)]))
  check('a run state carrying a secret is refused and never written', secret?.state === 'failed' && 'reason' in secret && secret.reason.includes('looks like a secret') && pendingRows(dir).length === 1, secret?.state === 'failed' ? secret.reason : secret?.state)

  acceptUserRequest(owner, { objective: 'Prove the disabled-memory road.', rootMessageId: null })
  process.env.MERCURY_BARE = '1'
  const off = envelopeOf(await fold([user('Prove the disabled road.'), ...rounds(14)]))
  delete process.env.MERCURY_BARE
  check('memory off: the fold says so and advertises no pointer', off?.state === 'failed' && 'reason' in off && off.reason === 'memory is off — nothing was stored', off?.state === 'failed' ? off.reason : off?.state)

  acceptUserRequest(owner, { objective: 'Prove the failed-write road.', rootMessageId: null })
  chmodSync(currentBufferPath(dir), 0o400)
  const unwritable = envelopeOf(await fold([user('Prove the failed write.'), ...rounds(14)]))
  chmodSync(currentBufferPath(dir), 0o600)
  check('a failed write is a failed envelope naming the disk failure, never a claimed move', unwritable?.state === 'failed' && 'reason' in unwritable && unwritable.reason.includes('the fact was NOT stored') && pendingRows(dir).length === 1, unwritable?.state === 'failed' ? unwritable.reason : unwritable?.state)

  acceptUserRequest(owner, { objective: 'Prove the cancelled road.', rootMessageId: null })
  const cancel = new AbortController()
  const cancelled = context({ abortController: cancel, onCompactProgress: (event: { type: string; stage?: string }) => { if (event.type === 'stage' && event.stage === 'restoring') cancel.abort() } })
  await assert.rejects(fold([user('Prove the cancelled road.'), ...rounds(14)], cancelled), APIUserAbortError)
  check('a fold cancelled before the write leaves memory untouched', pendingRows(dir).length === 1)

  acceptUserRequest(owner, { objective: 'Prove the crewmate road.', rootMessageId: null })
  const crew = envelopeOf(await fold([user('Prove the crewmate road.'), ...rounds(14)], context({ agentId: 'crewmate-1' })))
  check('a crewmate fold writes no project memory and says so', crew?.state === 'failed' && 'reason' in crew && crew.reason.startsWith('a crewmate fold writes no project memory') && pendingRows(dir).length === 1, crew?.state === 'failed' ? crew.reason : crew?.state)

  const struck = strikePendingRow({ ts: id.slice('pending:'.length), dir })
  check('a struck row makes the advertised pointer resolve to null, so a stale pointer is detectable and never silently claimed', struck.ok && memoryPointerForId(id, { dir }) === null && readBackStoredRow(id, dir) === null)
  check('zero unauthorised pins after every road', readPins(dir).length === 0)
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold memory retirement (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)

import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AssistantMessage, Message, PartialFoldDirection, UserMessage } from '../../src/engine/message-shapes/message.ts'
import type { FoldResult } from '../../src/engine/compaction/fold/foldResult.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'parallel-fold-')))
const exchange = process.argv[2] && resolve(process.argv[2])
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0' } })
Object.assign(process.env, { HOME: home, MERCURY_CONFIG_DIR: home, MERCURY_TMPDIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_COMPACT_KEEP_TAIL: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' })
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(home)
const api = await startFixtureApi(Array.from({ length: 16 }, () => ({ kind: 'text' as const, text: 'The earlier work is complete. Continue with the saved tool reports and the current request.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { asSessionId, asAgentId } = await import('../../src/sessions/transcripts/ids.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { createAssistantMessage, createUserMessage, createProgressMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createSystemMessage, createFoldBoundaryMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { getTranscriptPath, recordTranscript, recordSidechainTranscript, registerCrewmateTranscriptDestination, flushSessionStorage, resetProjectForTesting } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { settleTranscriptMessage, getSessionMessages } = await import('../../src/sessions/transcripts/writer.ts')
const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { buildScreenConversation, cleanForTranscript } = await import('../../src/sessions/transcripts/chain.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { historyHead, historyLines } = await import('../../src/sessions/transcripts/historyParts.ts')
const { pairConversationMessages } = await import('../../src/engine/message-shapes/resultPairing.ts')
const { buildPostFoldMessages, foldConversation, partialFoldConversation, annotateBoundaryWithPreservedSegment } = await import('../../src/engine/compaction/foldConversation.ts')
const { contextBuilder } = await import('../../src/engine/rows/turn/context.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/engine/tool-dispatch/toolResultStorage.ts')

const counts = { checks: 0, failures: 0 }
function check(scene: string, demand: string, ok: boolean): void {
  counts.checks++
  if (!ok) counts.failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} [${scene}] ${demand}${ok ? '' : ' — check the durable selection and parent order in sealPart.ts and rowGraph.ts'}`)
}
const ids = (rows: readonly Message[]) => rows.map(row => row.uuid)
const user = (content: string) => createUserMessage({ content })
const reply = (content: string) => createAssistantMessage({ content })
function call(name: string, group: string) {
  const row = createAssistantMessage({ content: [{ type: 'tool_use', name: 'Read', id: name, input: { file_path: name } }] })
  row.message.id = group
  row.message.model = 'claude-sonnet-5-5'
  row.message.stop_reason = 'tool_use'
  return { row, result: createUserMessage({ sourceToolAssistantUUID: row.uuid, content: [{ type: 'tool_result', tool_use_id: name, content: `answer ${name}` }] }) }
}
function raw(file: string): Array<{ recordId: string; parentId?: string }> {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
}
function wirePairs(rows: readonly Message[]): unknown[] {
  const wire = pairConversationMessages(rows.filter((m): m is AssistantMessage | UserMessage => m.type === 'assistant' || m.type === 'user'), 'split')
  return wire.flatMap((m, i) => {
    if (m.type !== 'assistant') return []
    const calls = m.message.content.flatMap(b => b.type === 'tool_use' ? [b.id] : [])
    if (calls.length === 0) return []
    const next = wire[i + 1]
    const results = next?.type === 'user' && Array.isArray(next.message.content) ? next.message.content.flatMap(b => b.type === 'tool_result' ? [[b.tool_use_id, b.content, b.is_error === true]] : []) : []
    return [[calls, results]]
  })
}
async function fold(rows: Message[], cut?: { at: number; direction: PartialFoldDirection }): Promise<FoldResult> {
  const readFileState = createFileStateCacheWithSizeLimit(8)
  let state = getDefaultAppState()
  const ctx = contextBuilder({ config: { cwd: home, tools: [], commands: [], agents: [], mcpClients: [], canUseTool: async () => { throw new Error('unexpected tool') }, getAppState: () => state, setAppState: update => { state = update(state) }, readFileState }, readFileState, turnId: randomUUID(), abortController: new AbortController(), thinkingConfig: { type: 'disabled' }, contentReplacementState: createContentReplacementState(), discoveredSkillNames: new Set(), loadedNestedMemoryPaths: new Set() })(rows, 'claude-sonnet-5-5')
  const cache = { systemPrompt: asSystemPrompt(['Fold the conversation.']), toolUseContext: ctx, userContext: {}, systemContext: {}, forkContextMessages: [] }
  return cut ? partialFoldConversation(rows, cut.at, ctx, cache, undefined, cut.direction) : foldConversation(rows, ctx, cache, false)
}
function start() {
  resetProjectForTesting()
  _resetTranscriptReaderForTesting()
  const sid = asSessionId(randomUUID())
  switchSession(sid)
  return sid
}
async function verify(scene: string, sid: ReturnType<typeof start>, selected: Message[], excluded: Message[], result: FoldResult, legacy = false) {
  const boundary = result.boundaryMarker, summary = result.summaryMessages[0]!
  const from = boundary.compactMetadata.preservedSegment?.anchorUuid === boundary.uuid
  const file = getTranscriptPath()
  const live = buildPostFoldMessages(result)
  await recordTranscript(live)
  await flushSessionStorage()
  const head = historyHead(file)
  const universe = new Set<string>(ids([...selected, ...excluded]))
  if (scene === 'over 5 MiB') check(scene, 'the live file exercises cold large-file resume', statSync(file).size > 5 * 1024 * 1024)
  const carry = raw(file).filter(r => universe.has(r.recordId))
  const expected = ids(selected)
  check(scene, 'the live file is sealed and carries exactly the selected durable IDs, once, in selection order', head.boundary === boundary.uuid && isDeepStrictEqual(carry.map(r => r.recordId), expected))
  if (!legacy) check(scene, 'each carry row names its predecessor (the head names the anchor)', carry.length === expected.length && carry.every((r, i) => r.parentId === (i ? expected[i - 1] : from ? boundary.uuid : summary.uuid)))
  const twin = join(home, `${boundary.uuid}.one.jsonl`)
  writeFileSync(twin, '')
  for (const line of historyLines(file)) appendFileSync(twin, line)
  const after = reply('Continue from this fold.')
  await recordTranscript([after])
  await flushSessionStorage()
  const last = [...historyLines(file)].at(-1)!
  appendFileSync(twin, last)
  const calls = selected.flatMap(m => m.type === 'assistant' ? m.message.content.flatMap(b => b.type === 'tool_use' ? [b.id] : []) : [])
  const expectedPairs = calls.length ? [[calls, calls.map(id => [id, `answer ${id}`, false])]] : []
  for (const [view, path] of [['sealed', file], ['one-file', twin]] as const) {
    _resetTranscriptReaderForTesting()
    const loaded = await loadTranscriptFile(path, { throwOnError: true })
    const screen = buildScreenConversation(loaded.messages)
    const model = (await loadConversationForResume(sid, path))?.messages ?? []
    check(scene, `${view}: screen holds every kept row once, in order, and no summarized rows`, isDeepStrictEqual(ids(screen).filter(id => universe.has(id)), expected) && screen.some(m => m.uuid === after.uuid))
    check(scene, `${view}: continued conversation retains the selected call and notice IDs only`, isDeepStrictEqual(ids(model).filter(id => universe.has(id)), expected) && model.some(m => m.uuid === after.uuid))
    check(scene, `${view}: real answers in call order in the following wire turn`, isDeepStrictEqual(wirePairs(model), expectedPairs))
  }
  if (exchange && scene === 'parallel') {
    copyFileSync(file, join(exchange, 'sealed.jsonl'))
    writeFileSync(join(exchange, 'witness.json'), JSON.stringify({ sid, expected, universe: [...universe], after: after.uuid, expectedPairs }))
  }
  return [...live, after]
}

try {
  for (const scene of ['parallel', 'reverse attachment', 'settled head', 'partial up_to', 'partial from', 'pending and ephemeral', 'over 5 MiB', '1.1.0 shape']) {
    const sid = start(), group = `msg_${sid}`
    const a = call('A', group), b = call('B', group), c = call('C', group)
    const before = [user('Earlier question.'), reply('Earlier material. '.repeat(1400)), user('Read both files.')]
    const quiet = scene === 'reverse attachment' ? createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: group, blockIndex: 0 }] }) : createSystemMessage('First notice.', 'info')
    const notice = createSystemMessage(scene === 'over 5 MiB' ? 'n'.repeat(5 * 1024 * 1024) : 'Second notice.', 'info')
    const pair = [a.row, quiet, b.row, notice, ...(scene === 'reverse attachment' ? [b.result, a.result] : [a.result, b.result])]
    const end = reply('Both reports arrived.')
    if (scene === 'partial up_to') before.push(c.row, c.result)
    const rows: Message[] = [...before, ...pair, ...(scene === 'partial from' ? [c.row, c.result] : []), end]
    await recordTranscript(rows.slice(0, -1))
    await flushSessionStorage()
    if (scene === 'settled head') {
      a.row.message.stop_sequence = 'settled-head'
      await settleTranscriptMessage(a.row)
      check(scene, 'writer appended a second copy of the selected head after its children', raw(getTranscriptPath()).filter(r => r.recordId === a.row.uuid).length === 2)
    }
    await recordTranscript([end])
    await flushSessionStorage()
    const parents = new Map(raw(getTranscriptPath()).map(r => [r.recordId, r.parentId]))
    check(scene, 'the writer placed the results on distinct branches', parents.get(a.result.uuid) === a.row.uuid && parents.get(b.result.uuid) === (scene === 'reverse attachment' ? notice.uuid : b.row.uuid))
    if (scene === 'parallel') {
      const result = await fold(rows)
      const selected = [...pair, end]
      check(scene, 'the actual full fold selects the whole parallel turn', isDeepStrictEqual(ids(result.messagesToKeep ?? []), ids(selected)))
      const next = await verify(scene, sid, selected, before, result)
      const cut = await fold(next, { at: next.findIndex(row => row.uuid === a.row.uuid), direction: 'up_to' })
      const retained = [...selected, ...cleanForTranscript(next.slice(next.findIndex(m => m.uuid === end.uuid) + 1))]
      await verify('refold', sid, retained, [...before, result.boundaryMarker, ...result.summaryMessages], cut)
    } else if (scene === 'partial from' || scene === 'partial up_to') {
      const from = scene === 'partial from'
      const result = await fold(rows, { at: rows.indexOf(from ? c.row : a.row), direction: from ? 'from' : 'up_to' })
      await verify(scene, sid, from ? [...before, ...pair] : [...pair, end], from ? [c.row, c.result, end] : before, result)
    } else {
      const boundary = createFoldBoundaryMessage('manual', 50000, end.uuid)
      const summary = createUserMessage({ content: 'Earlier work.', isCompactSummary: true })
      const selected: Message[] = [...pair, end]
      const kept = [...selected]
      const excluded: Message[] = [...before]
      const legacy = scene === '1.1.0 shape'
      if (legacy) {
        boundary.compactMetadata.preservedSegment = { headUuid: a.row.uuid, tailUuid: end.uuid, anchorUuid: summary.uuid }
        excluded.push(notice, a.result)
        selected.splice(selected.indexOf(notice), 2)
        selected.splice(selected.indexOf(a.row), 1)
        excluded.push(a.row)
        boundary.compactMetadata.preservedSegment.headUuid = quiet.uuid
      } else {
        if (scene === 'pending and ephemeral') {
          const pending = createSystemMessage('Selected but not yet written.', 'info')
          const absent = createAttachmentMessage({ type: 'diagnostics', files: [], isNew: false })
          kept.unshift(absent)
          kept.splice(3, 0, pending, quiet)
          kept.push(createAssistantMessage({ content: [] }))
          selected.splice(2, 0, pending)
          excluded.push(absent, kept.at(-1)!)
        }
        annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
      }
      await verify(scene, sid, selected, excluded, { boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: kept, hookResults: [], attachments: [], preFoldTokenCount: 50000, postFoldTokenCount: 1500 }, legacy)
      if (scene === 'settled head') check(scene, 'only the latest settled payload is carried', raw(getTranscriptPath()).filter(r => r.recordId === a.row.uuid && JSON.stringify(r).includes('settled-head')).length === 1)
    }
  }
  {
    const sid = start(), file = getTranscriptPath()
    const retired = user('Already summarized.'), stays = reply('Current work.')
    await recordTranscript([retired])
    const prior = createFoldBoundaryMessage('auto', 100, retired.uuid)
    await recordTranscript([prior, stays])
    await flushSessionStorage()
    const progress = createProgressMessage({ toolUseID: 'p', parentToolUseID: 'tool', data: { type: 'bash_progress', output: '', fullOutput: '', elapsedTimeSeconds: 0, totalLines: 0, totalBytes: 0 } })
    const encoded = encodeTranscriptLine(file, { ...progress, parentUuid: stays.uuid, isSidechain: false, sessionId: sid, cwd: home, version: '1.0.0' })
    appendFileSync(file, encoded.line)
    getSessionMessages.cache.clear?.()
    const boundary = createFoldBoundaryMessage('manual', 100, stays.uuid), summary = user('Latest summary.')
    const kept = [progress, retired, stays]
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
    await verify('archive and progress', sid, [stays], [retired, prior, progress], { boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: kept, hookResults: [], attachments: [], preFoldTokenCount: 100, postFoldTokenCount: 10 })
    const empty = createFoldBoundaryMessage('manual', 100, stays.uuid)
    annotateBoundaryWithPreservedSegment(empty, empty.uuid, [retired, progress])
    await recordTranscript([empty, user('Nothing kept.')])
    await flushSessionStorage()
    const emptyRecord = raw(file).find(r => r.recordId === empty.uuid)
    check('empty projection', 'a full seal with no stale segment if no selected chain row is resident', historyHead(file).boundary === empty.uuid && emptyRecord !== undefined && !JSON.stringify(emptyRecord).includes('preservedSegment'))
  }
  {
    const sid = start(), file = getTranscriptPath()
    const original = [user('Original prompt.'), reply('Original answer.'), user('Summarize this suffix.')]
    await recordTranscript(original)
    const first = buildPostFoldMessages(await fold(original, { at: 2, direction: 'from' }))
    await recordTranscript(first)
    const later = user('Another suffix.')
    await recordTranscript([later])
    const second = await fold([...first, later], { at: first.length, direction: 'from' })
    const after = reply('After both folds.')
    await recordTranscript([...buildPostFoldMessages(second), after])
    await flushSessionStorage()
    const expected = ids(cleanForTranscript(first))
    const legacy = join(home, 'nested-legacy.jsonl')
    const bytes = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => {
      const record = JSON.parse(line)
      const segment = record.payload.fields?.compactMetadata?.preservedSegment
      if (segment) delete segment.keptUuids
      return JSON.stringify(record)
    })
    writeFileSync(legacy, bytes.join('\n') + '\n')
    for (const [road, path] of [['manifest', file], ['released walk', legacy]]) {
      const screen = buildScreenConversation((await loadTranscriptFile(path!, { throwOnError: true })).messages)
      check('nested partial from', `${road} keeps the earlier boundary, summary and whole selected prefix once, in order`, isDeepStrictEqual(ids(screen).filter(id => expected.includes(id)), expected) && screen.at(-1)?.uuid === after.uuid)
    }
    if (exchange) {
      copyFileSync(file, join(exchange, 'nested.jsonl'))
      writeFileSync(join(exchange, 'nested-witness.json'), JSON.stringify({ sid, expected, after: after.uuid }))
    }
  }
  {
    start()
    const agent = asAgentId('a12345678'), first = join(home, 'crew-open.jsonl'), cold = join(home, 'crew-cold.jsonl')
    registerCrewmateTranscriptDestination(agent, first)
    const prompt = user('Keep the notice.'), notice = createSystemMessage('A quiet update.', 'info'), done = reply('Finished.')
    await recordSidechainTranscript([prompt, notice, done], agent)
    await flushSessionStorage()
    copyFileSync(first, cold)
    registerCrewmateTranscriptDestination(agent, cold)
    const boundary = createFoldBoundaryMessage('auto', 100, done.uuid), summary = user('Earlier crew work.')
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, [prompt, notice, done])
    await recordSidechainTranscript([boundary, summary], agent, done.uuid)
    await flushSessionStorage()
    const loaded = await loadTranscriptFile(cold, { throwOnError: true })
    check('cold crewmate writer', 'a notice already resident before this writer opened the file stays between the kept prompt and reply', loaded.messages.get(notice.uuid)?.parentUuid === prompt.uuid && loaded.messages.get(done.uuid)?.parentUuid === notice.uuid)
  }
  {
    const sid = start(), file = getTranscriptPath(), stored = user('A durable prompt.'), missing = reply('Absent from the file.'), tail = reply('A durable tail.')
    await recordTranscript([stored, tail])
    await flushSessionStorage()
    const boundary = createFoldBoundaryMessage('manual', 100, stored.uuid)
    boundary.compactMetadata.preservedSegment = { headUuid: stored.uuid, anchorUuid: boundary.uuid, tailUuid: tail.uuid, keptUuids: [stored.uuid, missing.uuid, tail.uuid] }
    const entry = { ...boundary, parentUuid: null, isSidechain: false, sessionId: sid, cwd: home, version: '1.0.0' }
    const encoded = encodeTranscriptLine(file, entry)
    const queue = new QueuePart()
    const landed = queue.enqueueRawLine(file, encoded.line, undefined, encoded.record)
    await queue.flush()
    await landed
    const loaded = await loadTranscriptFile(file, { throwOnError: true })
    check('missing declaration', 'an absent required ID drains unsealed without changing or pruning the original rows', historyHead(file).before === 0 && loaded.messages.get(stored.uuid)?.parentUuid === null && loaded.messages.has(boundary.uuid))
    const next = createFoldBoundaryMessage('auto', 100, boundary.uuid)
    const summary = user('A later fold.')
    annotateBoundaryWithPreservedSegment(next, summary.uuid, [stored])
    await recordTranscript([next, summary])
    await flushSessionStorage()
    check('missing declaration', 'a later valid fold can still seal and load', historyHead(file).boundary === next.uuid && (await loadTranscriptFile(file)).messages.get(stored.uuid)?.parentUuid === summary.uuid)
  }
} finally {
  await api.close()
  rmSync(home, { force: true, recursive: true })
}
console.log(`${counts.checks - counts.failures}/${counts.checks} passed`)
process.exit(counts.failures ? 1 : 0)

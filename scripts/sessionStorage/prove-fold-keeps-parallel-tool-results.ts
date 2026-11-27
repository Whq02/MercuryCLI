import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const api = await startFixtureApi(Array.from({ length: 32 }, () => ({ kind: 'text' as const, text: 'The earlier work is complete. Continue with the saved tool reports and the current request.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { asSessionId, asAgentId } = await import('../../src/sessions/transcripts/ids.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { createAssistantMessage, createUserMessage, createProgressMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createSystemMessage, createCommandInputMessage, createFoldBoundaryMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { getTranscriptPath, recordTranscript, recordSidechainTranscript, registerCrewmateTranscriptDestination, flushSessionStorage, resetProjectForTesting } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { settleTranscriptMessage, getSessionMessages } = await import('../../src/sessions/transcripts/writer.ts')
const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { buildScreenConversation, cleanForTranscript, removeExtraFields } = await import('../../src/sessions/transcripts/chain.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { listCrewmateTranscriptPaths } = await import('../../src/sessions/transcripts/paths.ts')
const { historyHead, historyLines, historyPartDir } = await import('../../src/sessions/transcripts/historyParts.ts')
const { pairConversationMessages } = await import('../../src/engine/message-shapes/resultPairing.ts')
const { planApiConversation } = await import('../../src/engine/messages/apiPlan.ts')
const { electConversationEnd } = await import('../../src/sessions/transcripts/conversationEnd.ts')
const { keptLine } = await import('../../src/sessions/transcripts/rowGraph.ts')
const { SNAPSHOT_SCHEMA, snapshotPathFor, tryLoadResumeSnapshot } = await import('../../src/sessions/transcripts/resumeSnapshot.ts')
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
function crew(content: string): Message {
  return { type: 'system', subtype: 'crew_chat', level: 'info', isMeta: false, uuid: randomUUID(), timestamp: new Date().toISOString(), content, seq: 1, name: 'poster', authorRole: 'peer', kind: 'ask', mentions: [], addresses: ['main'] }
}
function beside(file: string, sid: ReturnType<typeof start>, row: Message, parent: Message): void {
  appendFileSync(file, encodeTranscriptLine(file, { ...row, parentUuid: parent.uuid, isSidechain: false, sessionId: sid, cwd: home, version: '1.0.0' }).line)
  getSessionMessages.cache.clear?.()
}
function unseal(sid: ReturnType<typeof start>, file: string, twin: string): void {
  rmSync(historyPartDir(file), { recursive: true, force: true })
  copyFileSync(twin, file)
  resetProjectForTesting()
  _resetTranscriptReaderForTesting()
  switchSession(sid)
  getSessionMessages.cache.clear?.()
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
  const views: [string, string][] = [['sealed', file], ['one-file', twin]]
  if (!legacy) {
    const rollback = join(home, `${boundary.uuid}.rollback.jsonl`)
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => {
      const record = JSON.parse(line)
      const segment = record.payload.fields?.compactMetadata?.preservedSegment
      if (record.recordId !== boundary.uuid || !segment) return line
      delete segment.keptUuids
      return JSON.stringify(record)
    })
    writeFileSync(rollback, lines.join('\n') + '\n')
    views.push(['released walk', rollback])
  }
  for (const [view, path] of views) {
    _resetTranscriptReaderForTesting()
    const loaded = await loadTranscriptFile(path, { throwOnError: true })
    const screen = buildScreenConversation(loaded.messages)
    const model = (await loadConversationForResume(sid, path))?.messages ?? []
    check(scene, `${view}: screen holds every kept row once, in order, and no summarized rows`, isDeepStrictEqual(ids(screen).filter(id => universe.has(id)), expected) && screen.some(m => m.uuid === after.uuid))
    check(scene, `${view}: continued conversation retains the selected call and notice IDs only`, isDeepStrictEqual(ids(model).filter(id => universe.has(id)), expected) && model.some(m => m.uuid === after.uuid))
    check(scene, `${view}: real answers in call order in the following wire turn`, isDeepStrictEqual(wirePairs(model), expectedPairs))
  }
  if (exchange && scene === (process.argv[3] ?? 'parallel')) {
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
  for (const scene of ['board rows', 'board rows around a rewound turn']) {
    const sid = start(), group = `msg_${sid}`, file = getTranscriptPath()
    const a = call('A', group)
    const before = [user('Earlier question.'), reply('Earlier material. '.repeat(16000)), user('Run the slow check.')]
    const end = reply('The check ran.')
    const turn: Message[] = [...before, a.row], all: Message[] = [...turn]
    const runner = async (row: Message) => { all.push(row); await recordTranscript([row], undefined, all) }
    const joined = crew('joined'), post = crew('@main BOARD-POST-DURING-FOLD?'), typed = createCommandInputMessage('/swarm on'), retry = createSystemMessage('Retrying in 2 seconds.', 'warning')
    const note = createUserMessage({ content: 'A host notice.', isVirtual: true, origin: { kind: 'task-notification' } })
    const stray = scene === 'board rows' ? [] : [user('A rewound turn.'), reply('Its abandoned answer.')]
    await recordTranscript(turn)
    await runner(joined)
    await runner(post)
    if (stray.length) {
      await runner(typed)
      await runner(retry)
      await flushSessionStorage()
      beside(file, sid, stray[0]!, before[0]!)
      beside(file, sid, stray[1]!, stray[0]!)
    }
    await recordTranscript([a.result])
    await runner(note)
    await recordTranscript([end])
    await flushSessionStorage()
    turn.push(a.result, end)
    const line = [a.row, joined, post, ...(stray.length ? [typed, retry] : []), a.result, note, end]
    const parents = new Map(raw(file).map(r => [r.recordId, r.parentId]))
    check(scene, 'the writer hung each row on the live leaf: the result under the board rows, the reply under the notice', line.every((row, i) => i === 0 || parents.get(row.uuid) === line[i - 1]!.uuid))
    const result = await fold(turn)
    check(scene, 'the list of the actual fold holds the rows of the turn and none the runner wrote', isDeepStrictEqual(ids(result.messagesToKeep ?? []), ids([a.row, a.result, end])))
    const next = await verify(scene, sid, line, [...before, ...stray], result)
    _resetTranscriptReaderForTesting()
    const resumed = (await loadConversationForResume(sid, file))?.messages ?? []
    const unsent = new Set<string>(ids([joined, post, note, ...(stray.length ? [retry] : [])]))
    check(scene, 'a resume holds the board rows and plans the same request with them as without them', [...unsent].every(id => resumed.some(m => m.uuid === id)) && isDeepStrictEqual(planApiConversation(resumed).selected, planApiConversation(resumed.filter(m => !unsent.has(m.uuid))).selected))
    if (stray.length) check(scene, 'a typed command on the kept line rides the resumed request, as the released walk sends it', planApiConversation(resumed).selected.some(m => m.uuid === typed.uuid))
    else {
      const twin = join(home, `${result.boundaryMarker.uuid}.one.jsonl`), sidecar = snapshotPathFor(twin), flag = process.env.MERCURY_RESUME_SNAPSHOT
      delete process.env.MERCURY_RESUME_SNAPSHOT
      try {
        rmSync(sidecar, { force: true })
        _resetTranscriptReaderForTesting()
        await loadTranscriptFile(twin)
        const fresh = JSON.parse(readFileSync(sidecar, 'utf8')) as { schemaVersion: number; fold: { messages: { '«map»': Array<[string, unknown]> } }; order: string[] }
        check(scene, 'a resume of the one-file copy leaves a snapshot that holds the board rows', fresh.schemaVersion === SNAPSHOT_SCHEMA && [...unsent].every(id => fresh.order.includes(id)))
        writeFileSync(sidecar, JSON.stringify({ ...fresh, schemaVersion: 7, fold: { ...fresh.fold, messages: { '«map»': fresh.fold.messages['«map»'].filter(([id]) => !unsent.has(id)) } }, order: fresh.order.filter(id => !unsent.has(id)) }))
        const refused = (await tryLoadResumeSnapshot(twin, true)) === null
        _resetTranscriptReaderForTesting()
        const screen = buildScreenConversation((await loadTranscriptFile(twin, { throwOnError: true })).messages)
        check(scene, 'the snapshot the faulty build left without them (schema 7) is refused and the rows are read from the file again', refused && isDeepStrictEqual(ids(screen).filter(id => line.some(row => row.uuid === id)), ids(line)))
      } finally {
        if (flag === undefined) delete process.env.MERCURY_RESUME_SNAPSHOT
        else process.env.MERCURY_RESUME_SNAPSHOT = flag
      }
    }
    const gone = [...before, ...stray, result.boundaryMarker, ...result.summaryMessages]
    const cut = await fold(next, { at: next.findIndex(row => row.uuid === a.row.uuid), direction: 'up_to' })
    const twice = await verify(`${scene}, refold`, sid, [...line, ...cleanForTranscript(next.slice(next.findIndex(m => m.uuid === end.uuid) + 1))], gone, cut)
    unseal(sid, file, join(home, `${cut.boundaryMarker.uuid}.one.jsonl`))
    const again = [...twice, user('One more request.')]
    await recordTranscript(again)
    await flushSessionStorage()
    check(`${scene}, a flattened copy folded again`, 'the copy stands unsealed with both earlier boundaries in it', historyHead(file).before === 0 && raw(file).filter(r => r.recordId === result.boundaryMarker.uuid || r.recordId === cut.boundaryMarker.uuid).length === 2)
    const third = await fold(again, { at: again.findIndex(row => row.uuid === a.row.uuid), direction: 'up_to' })
    await verify(`${scene}, a flattened copy folded again`, sid, [...line, ...cleanForTranscript(again.slice(again.findIndex(m => m.uuid === end.uuid) + 1))], [...gone, cut.boundaryMarker, ...cut.summaryMessages], third)
  }
  for (const scene of ['listed notes of an earlier kept turn', 'listed notes beside a typed command']) {
    const sid = start(), group = `msg_${sid}`, file = getTranscriptPath()
    const a = call('A', group)
    const before = [user('Earlier question.'), reply('Earlier material. '.repeat(1400)), user('Second question.'), reply('Second answer.'), user('Third question.'), reply('Third answer.')]
    const ask = user('Run the slow check.'), end = reply('The check ran.'), then = user('And a slow answer.'), done = reply('The slow answer.')
    const joined = crew('joined'), post = crew('@main BOARD-POST-IN-AN-EARLIER-TURN?'), typed = createCommandInputMessage('/swarm on')
    const held: Message[] = [...before]
    const runner = async (row: Message) => { held.push(row); await recordTranscript([row], undefined, held) }
    await recordTranscript([...before, ask, a.row])
    await runner(joined)
    await runner(post)
    if (scene !== 'listed notes of an earlier kept turn') await runner(typed)
    await recordTranscript([a.result])
    await recordTranscript([end])
    await recordTranscript([then, done])
    await flushSessionStorage()
    held.push(ask, a.row, a.result, end, then, done)
    const tail = held.slice(3)
    const written = [...before.slice(3), ask, a.row, joined, post, ...tail.filter(row => row === typed), a.result, end, then, done]
    const line = scene === 'listed notes of an earlier kept turn' ? written : [...before.slice(3), typed, ask, a.row, joined, post, a.result, end, then, done]
    _resetTranscriptReaderForTesting()
    const shown = ids(buildScreenConversation((await loadTranscriptFile(file, { throwOnError: true })).messages))
    check(scene, 'before the fold the screen reads the turn as it was written, the notes under its call', isDeepStrictEqual(shown.filter(id => written.some(row => row.uuid === id)), ids(written)))
    const result = await fold(held)
    check(scene, 'the list of the actual fold names the notes, ahead of the prompt of their turn', isDeepStrictEqual(ids(result.messagesToKeep ?? []), ids(tail)) && tail.includes(joined) && tail.indexOf(joined) < tail.indexOf(ask))
    const next = await verify(scene, sid, line, before.slice(0, 3), result)
    _resetTranscriptReaderForTesting()
    const elected = electConversationEnd((await loadTranscriptFile(file, { throwOnError: true })).messages)?.rows ?? []
    check(scene, 'the elected line holds the kept rows in that same order', isDeepStrictEqual(ids(elected).filter(id => line.some(row => row.uuid === id)), ids(line)))
    _resetTranscriptReaderForTesting()
    const resumed = (await loadConversationForResume(sid, file))?.messages ?? []
    const sent = ids(planApiConversation(resumed).selected)
    check(scene, 'the request a resume plans holds the rows a request takes in the order of the list, and no note', isDeepStrictEqual(sent.filter(id => tail.some(row => row.uuid === id)), ids(tail.filter(row => row !== joined && row !== post))))
    const late = createSystemMessage('Under the kept note, after the fold.', 'info')
    beside(file, sid, late, joined)
    const cut = await fold(next, { at: next.findIndex(row => row.uuid === tail[0]!.uuid), direction: 'up_to' })
    check(scene, 'the list of the refold names the kept note and not the note hung under it since', (cut.messagesToKeep ?? []).some(row => row.uuid === joined.uuid) && !(cut.messagesToKeep ?? []).some(row => row.uuid === late.uuid))
    await verify(`${scene}, refold`, sid, [...line.flatMap(row => row === joined ? [joined, late] : [row]), ...cleanForTranscript(next.slice(next.findIndex(m => m.uuid === done.uuid) + 1))], [...before.slice(0, 3), result.boundaryMarker, ...result.summaryMessages], cut)
  }
  {
    const scene = 'the line never drops a row'
    type Drawn = { ids: string[]; parent: Record<string, string | null>; note: Record<string, boolean>; at: Record<string, number>; floor: number; listed: string[] }
    const lineOf = (drawn: Drawn, moves: boolean): string[] => keptLine(drawn.listed, id => drawn.parent[id], id => drawn.ids.filter(child => drawn.parent[child] === id && drawn.note[child] === true && drawn.at[child]! > drawn.floor), id => moves && drawn.note[id] === true)
    const hand = (rows: string, listed: string, floor = -1): Drawn => {
      const drawn: Drawn = { ids: [], parent: {}, note: {}, at: {}, floor, listed: listed.split(' ') }
      rows.split(' ').forEach((word, n) => {
        const [name = '', under = '-'] = word.split('<')
        const id = name.replace('*', '')
        drawn.ids.push(id)
        drawn.parent[id] = under === '-' ? null : under
        drawn.note[id] = name.endsWith('*')
        drawn.at[id] = n
      })
      return drawn
    }
    const reads = (rows: string, listed: string, line: string, floor = -1): boolean => lineOf(hand(rows, listed, floor), true).join(' ') === line
    check(scene, 'the notes the runner listed ahead of their prompt stand under the call they were written under', reads('A0<- PROMPT<A0 CALL<PROMPT JOIN*<CALL POST*<JOIN RESULT<POST REPLY<RESULT', 'A0 JOIN POST PROMPT CALL RESULT REPLY', 'A0 PROMPT CALL JOIN POST RESULT REPLY'))
    check(scene, 'a listed note the earlier fold kept, on the line, keeps the note written under it after that fold', reads('A0<- J*<A0 FOLD<- K*<J U<J Z<U', 'A0 J U Z', 'A0 J K U Z', 2))
    check(scene, 'the same note inside the window keeps it too', reads('A0<- J*<A0 FOLD<- K*<J U<J Z<U', 'A0 J U Z', 'A0 J K U Z'))
    check(scene, 'two listed notes off the line, the list naming the lower first, keep the note under the lower', reads('A0<- U<A0 Z<U N2*<GONE N1*<N2 C*<N1', 'A0 N1 N2 U Z', 'A0 N2 N1 C U Z'))
    check(scene, 'the same two named in their written order read the same line', reads('A0<- U<A0 Z<U N2*<GONE N1*<N2 C*<N1', 'A0 N2 N1 U Z', 'A0 N2 N1 C U Z'))
    check(scene, 'three listed notes in a chain, named lowest first, keep every row and the note under each', reads('A0<- U<A0 Z<U N3*<GONE N2*<N3 N1*<N2 C1*<N1 C2*<N2 C3*<N3', 'A0 N1 N2 N3 U Z', 'A0 N3 C3 N2 C2 N1 C1 U Z'))
    check(scene, 'two listed notes that name each other as parent are both kept, once', reads('A0<- U<A0 Z<U N1*<N2 N2*<N1', 'A0 N1 N2 U Z', 'A0 N1 N2 U Z'))
    let seed = 1
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = (n: number): number => Math.floor(rnd() * n)
    for (const mode of ['the order of the runner, one fold', 'the order of the runner, a second fold', 'the written order, a second fold']) {
      let drawn = 0, broken = 0, moved = 0
      for (let n = 0; n < 20000; n++) {
        const size = 6 + pick(10)
        const rows: Drawn = { ids: [], parent: {}, note: {}, at: {}, floor: -1, listed: [] }
        const turn: Record<string, number> = {}
        let leaf: string | null = null, turns = 0
        for (let i = 0; i < size; i++) {
          const id = `r${i}`
          rows.ids.push(id)
          rows.at[id] = i
          rows.note[id] = i > 0 && rnd() < 0.4
          if (!rows.note[id] && rnd() < 0.35) turns++
          turn[id] = turns
          const off = leaf !== null && rnd() < 0.25
          rows.parent[id] = off && leaf !== null ? rows.parent[leaf] ?? leaf : leaf
          if (!(rows.note[id] && rnd() < 0.3)) leaf = id
        }
        const first = rows.ids.findIndex((id, i) => !rows.note[id] && i >= pick(Math.max(1, size - 4)))
        if (first < 0) continue
        let kept = rows.ids.slice(first)
        if (mode.startsWith('the order of the runner')) {
          const held: string[] = []
          for (const row of kept) {
            const start = rows.note[row] ? held.findIndex(other => !rows.note[other] && turn[other] === turn[row]) : -1
            if (start >= 0) held.splice(start, 0, row)
            else held.push(row)
          }
          kept = held
        }
        if (kept.length < 2 || rows.note[kept[0]!]) continue
        if (mode.endsWith('a second fold')) rows.floor = rows.at[kept[0]!]! + pick(Math.max(1, kept.length - 1))
        rows.listed = kept.filter(row => !(rows.note[row] && rnd() < 0.3))
        if (rows.listed.length < 2 || rows.note[rows.listed[0]!]) continue
        drawn++
        const still = lineOf(rows, false), line = lineOf(rows, true), fixed = (id: string, at: number, all: string[]): boolean => rows.listed.includes(id) && (!rows.note[id] || id === rows.listed[0] || id === rows.listed.at(-1)) && all.indexOf(id) === at
        if (line.join(' ') !== still.join(' ')) moved++
        if (line.length !== still.length || new Set(line).size !== line.length || !still.every(id => line.includes(id)) || line[0] !== rows.listed[0] || line.at(-1) !== rows.listed.at(-1) || line.filter(fixed).join(' ') !== rows.listed.filter(fixed).join(' ')) broken++
      }
      check(scene, `${mode}: over the drawn lists the line holds the rows it holds when no row may move, each once, the ends of the list in place and its other rows in its order`, drawn > 5000 && moved > 1000 && broken === 0)
    }
  }
  {
    const sid = start(), a = call('A', `msg_${sid}`)
    const asked = user('Run the slow check.'), end = reply('The check ran.'), last = crew('joined')
    const held: Message[] = [asked]
    await recordTranscript([asked, a.row])
    held.push(last)
    await recordTranscript([last], undefined, held)
    await recordTranscript([a.result])
    await recordTranscript([end])
    await flushSessionStorage()
    const boundary = createFoldBoundaryMessage('manual', 100, end.uuid), summary = createUserMessage({ content: 'Earlier work.', isCompactSummary: true })
    const kept = [a.row, a.result, end, last]
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
    await verify('list ends on a note written earlier', sid, kept, [asked], { boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: kept, hookResults: [], attachments: [], preFoldTokenCount: 100, postFoldTokenCount: 10 })
  }
  {
    const scene = 'a listed note beside the line'
    const sid = start(), group = `msg_${sid}`, file = getTranscriptPath()
    const a = call('A', group), b = call('B', group)
    const before = [user('Earlier question.'), reply('Earlier material. '.repeat(1400)), user('Second question.'), reply('Second answer.'), user('Third question.'), reply('Third answer.')]
    const ask = user('Launch both.'), end = reply('Both reports arrived.'), joined = crew('joined'), echo = createSystemMessage('Under the listed note.', 'info')
    const held: Message[] = [...before]
    await recordTranscript([...before, ask, a.row, b.row])
    held.push(joined)
    await recordTranscript([joined], undefined, held)
    await recordTranscript([a.result])
    await recordTranscript([b.result])
    await flushSessionStorage()
    beside(file, sid, echo, joined)
    await recordTranscript([end])
    await flushSessionStorage()
    held.push(ask, a.row, b.row, a.result, b.result, end)
    const parents = new Map(raw(file).map(r => [r.recordId, r.parentId]))
    check(scene, 'the writer hung the note beside the line under the second call, and a note under it', parents.get(joined.uuid) === b.row.uuid && parents.get(echo.uuid) === joined.uuid && parents.get(b.result.uuid) === b.row.uuid && parents.get(end.uuid) === b.result.uuid)
    const result = await fold(held)
    check(scene, 'the list of the actual fold names the first note ahead of the prompt and not the note under it', isDeepStrictEqual(ids(result.messagesToKeep ?? []), ids(held.slice(3))))
    await verify(scene, sid, [...before.slice(3), ask, a.row, b.row, joined, echo, a.result, b.result, end], before.slice(0, 3), result)
  }
  for (const scene of ['side rows, results in order', 'side rows, results reversed']) {
    const sid = start(), group = `msg_${sid}`, file = getTranscriptPath()
    const a = call('A', group), b = call('B', group)
    const before = [user('Earlier question.'), reply('Earlier material. '.repeat(1400)), user('Launch both.')]
    const end = reply('Both reports arrived.')
    const results = scene === 'side rows, results reversed' ? [b.result, a.result] : [a.result, b.result]
    const turn: Message[] = [...before, a.row, b.row], all: Message[] = [...turn]
    const runner = async (row: Message) => { all.push(row); await recordTranscript([row], undefined, all) }
    const joined = crew('joined'), post = crew('@main BOARD-POST-DURING-FOLD?'), late = crew('After the last kept row.')
    const typed = createCommandInputMessage('/swarm on'), pinned = createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: 'msg_none', blockIndex: 0 }] })
    const aside = createUserMessage({ content: 'A host notice.', isVirtual: true, origin: { kind: 'task-notification' } }), behind = createSystemMessage('Behind the notice.', 'info')
    await recordTranscript(turn)
    await runner(joined)
    await recordTranscript([results[0]!])
    await recordTranscript([results[1]!])
    await runner(post)
    await flushSessionStorage()
    beside(file, sid, typed, b.row)
    beside(file, sid, pinned, b.row)
    beside(file, sid, aside, a.row)
    beside(file, sid, behind, aside)
    await recordTranscript([end])
    await runner(late)
    await flushSessionStorage()
    turn.push(...results, end)
    const line = [a.row, b.row, joined, ...results, post, end]
    const parents = new Map(raw(file).map(r => [r.recordId, r.parentId]))
    check(scene, 'the writer hung the joined row beside the line under the second call and the post on the line', parents.get(joined.uuid) === b.row.uuid && parents.get(a.result.uuid) === a.row.uuid && parents.get(b.result.uuid) === (results[0] === b.result ? joined.uuid : b.row.uuid) && parents.get(post.uuid) === results[1]!.uuid && parents.get(end.uuid) === post.uuid && parents.get(late.uuid) === end.uuid)
    const result = await fold(turn)
    check(scene, 'the list of the actual fold holds the rows of the turn and none the runner wrote', isDeepStrictEqual(ids(result.messagesToKeep ?? []), ids([a.row, b.row, ...results, end])))
    const next = await verify(scene, sid, line, [...before, typed, pinned, aside, behind, late], result)
    _resetTranscriptReaderForTesting()
    const resumed = (await loadConversationForResume(sid, file))?.messages ?? []
    const unsent = new Set<string>(ids([joined, post]))
    check(scene, 'a resume holds both board rows and plans the same request with them as without them', [...unsent].every(id => resumed.some(m => m.uuid === id)) && isDeepStrictEqual(planApiConversation(resumed).selected, planApiConversation(resumed.filter(m => !unsent.has(m.uuid))).selected))
    const gone = [...before, typed, pinned, aside, behind, late, result.boundaryMarker, ...result.summaryMessages]
    const cut = await fold(next, { at: next.findIndex(row => row.uuid === a.row.uuid), direction: 'up_to' })
    const twice = await verify(`${scene}, refold`, sid, [...line, ...cleanForTranscript(next.slice(next.findIndex(m => m.uuid === end.uuid) + 1))], gone, cut)
    unseal(sid, file, join(home, `${cut.boundaryMarker.uuid}.one.jsonl`))
    const again = [...twice, user('One more request.')]
    await recordTranscript(again)
    await flushSessionStorage()
    check(`${scene}, a flattened copy folded again`, 'the copy stands unsealed with both earlier boundaries in it', historyHead(file).before === 0 && raw(file).filter(r => r.recordId === result.boundaryMarker.uuid || r.recordId === cut.boundaryMarker.uuid).length === 2)
    const third = await fold(again, { at: again.findIndex(row => row.uuid === a.row.uuid), direction: 'up_to' })
    await verify(`${scene}, a flattened copy folded again`, sid, [...line, ...cleanForTranscript(again.slice(again.findIndex(m => m.uuid === end.uuid) + 1))], [...gone, cut.boundaryMarker, ...cut.summaryMessages], third)
  }
  {
    const sid = start(), file = getTranscriptPath()
    const asked = user('Earlier question.'), told = reply('Earlier answer.'), aside = createSystemMessage('Beside the line.', 'info'), under = createSystemMessage('Under the listed head.', 'info'), between = createSystemMessage('On the written line.', 'info'), done = reply('Done.')
    await recordTranscript([asked, told])
    await flushSessionStorage()
    beside(file, sid, aside, asked)
    beside(file, sid, under, aside)
    await recordTranscript([between], undefined, [asked, told, between])
    await recordTranscript([done])
    await flushSessionStorage()
    const boundary = createFoldBoundaryMessage('manual', 100, done.uuid), summary = createUserMessage({ content: 'Earlier work.', isCompactSummary: true })
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, [aside, done])
    await verify('list head off the line', sid, [aside, under, done], [asked, told, between], { boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: [aside, done], hookResults: [], attachments: [], preFoldTokenCount: 100, postFoldTokenCount: 10 })
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
    const sid = start()
    const original = [user('First request.'), reply('Earlier material. '.repeat(1400)), user('Second request.'), reply('Keep this answer.')]
    await recordTranscript(original)
    const first = await fold(original)
    const replay = [...buildPostFoldMessages(first), user('Next request.'), reply('Next answer.')]
    await recordTranscript(replay)
    const second = await fold(replay)
    await recordTranscript(buildPostFoldMessages(second))
    await flushSessionStorage()
    const paths = await listCrewmateTranscriptPaths(getTranscriptPath(), sid)
    const forks = paths.filter(path => raw(path).some(row => row.recordId === first.boundaryMarker.uuid))
    const file = forks[0]
    const expected = ids(cleanForTranscript(replay))
    check('fold summariser fork', 'the second full fold replayed the first fold into one fork', historyHead(getTranscriptPath()).boundary === second.boundaryMarker.uuid && forks.length === 1)
    check('fold summariser fork', 'the replay wrote no archive or index', file !== undefined && historyHead(file).before === 0 && !existsSync(historyPartDir(file)))
    check('fold summariser fork', 'replayed rows stand once in their original physical order', file !== undefined && isDeepStrictEqual(raw(file).map(row => row.recordId).filter(id => expected.some(uuid => uuid === id)), expected))
  }
  for (const listed of [true, false]) {
    start()
    const scene = listed ? 'cold crewmate writer' : 'cold crewmate writer, unlisted notice'
    const agent = asAgentId(listed ? 'a12345678' : 'a12345679'), first = join(home, `crew-open-${listed ? 'listed' : 'unlisted'}.jsonl`), cold = join(home, `crew-cold-${listed ? 'listed' : 'unlisted'}.jsonl`)
    registerCrewmateTranscriptDestination(agent, first)
    const prompt = user('Keep the notice.'), notice = createSystemMessage('A quiet update.', 'info'), done = reply('Finished.')
    await recordSidechainTranscript([prompt, notice, done], agent)
    await flushSessionStorage()
    copyFileSync(first, cold)
    registerCrewmateTranscriptDestination(agent, cold)
    const boundary = createFoldBoundaryMessage('auto', 100, done.uuid), summary = user('Earlier crew work.')
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, listed ? [prompt, notice, done] : [prompt, done])
    await recordSidechainTranscript([boundary, summary], agent, done.uuid)
    await flushSessionStorage()
    const head = historyHead(cold), expected = ids([prompt, notice, done]), universe = new Set<string>(expected)
    const carry = raw(cold).filter(r => universe.has(r.recordId))
    check(scene, 'the seat file is sealed and its head carries prompt, notice and reply once in order, each naming its predecessor', head.boundary === boundary.uuid && isDeepStrictEqual(carry.map(r => r.recordId), expected) && carry.every((r, i) => r.parentId === (i ? expected[i - 1] : summary.uuid)))
    const loaded = await loadTranscriptFile(cold, { throwOnError: true })
    check(scene, 'a notice already resident before this writer opened the file stays between the kept prompt and reply', loaded.messages.get(notice.uuid)?.parentUuid === prompt.uuid && loaded.messages.get(done.uuid)?.parentUuid === notice.uuid)
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
  const damagedLists: Array<[string, unknown]> = [['string', 'not-an-array'], ['object', { bad: 1 }]]
  for (const [kind, badList] of damagedLists) {
    const sid = start(), file = getTranscriptPath()
    const older = user('Older turn.'), keeps = reply('Kept row.')
    await recordTranscript([older, keeps])
    await flushSessionStorage()
    const prior = createFoldBoundaryMessage('auto', 100, keeps.uuid)
    prior.compactMetadata.preservedSegment = { headUuid: older.uuid, anchorUuid: prior.uuid, tailUuid: keeps.uuid }
    const priorRecord = JSON.parse(encodeTranscriptLine(file, { ...prior, parentUuid: null, isSidechain: false, sessionId: sid, cwd: home, version: '1.0.0' }).line)
    priorRecord.payload.fields.compactMetadata.preservedSegment.keptUuids = badList
    appendFileSync(file, JSON.stringify(priorRecord) + '\n')
    getSessionMessages.cache.clear?.()
    _resetTranscriptReaderForTesting()
    const beforeFold = await loadTranscriptFile(file, { throwOnError: true })
    check(`damaged prior fold (${kind})`, 'before the new fold the loader skips the damaged keptUuids without throwing or relinking', beforeFold.messages.has(prior.uuid) && beforeFold.messages.get(older.uuid)?.parentUuid === null && beforeFold.messages.get(keeps.uuid)?.parentUuid === older.uuid)
    const [loadedPrior, loadedKeeps] = removeExtraFields([beforeFold.messages.get(prior.uuid)!, beforeFold.messages.get(keeps.uuid)!])
    if (!loadedPrior || !loadedKeeps) throw new Error('missing loaded damaged rows')
    const next = createFoldBoundaryMessage('manual', 100, keeps.uuid), summary = user('Fresh summary.'), after = reply('Landed after seal.')
    annotateBoundaryWithPreservedSegment(next, summary.uuid, [keeps])
    let sealThrew = false
    try {
      await recordTranscript([next, summary])
      await flushSessionStorage()
      await recordTranscript([after])
      await flushSessionStorage()
    } catch { sealThrew = true }
    const sealedRows = raw(file)
    check(`damaged prior fold (${kind})`, 'a later fold seals past the damaged older fold line and a row written after it lands', !sealThrew && historyHead(file).boundary === next.uuid && sealedRows.some(r => r.recordId === after.uuid))
    const forkAgent = asAgentId(`a1234568${kind === 'string' ? '1' : '2'}`), forkFile = join(home, `damaged-fork-${kind}.jsonl`)
    registerCrewmateTranscriptDestination(forkAgent, forkFile)
    let forkThrew = false
    try {
      await recordSidechainTranscript([loadedPrior, loadedKeeps], forkAgent)
      await flushSessionStorage()
    } catch { forkThrew = true }
    const forkRecords = existsSync(forkFile) ? readFileSync(forkFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : []
    const forkPrior = forkRecords.find(r => r.recordId === prior.uuid)
    _resetTranscriptReaderForTesting()
    const forkLoaded = existsSync(forkFile) ? await loadTranscriptFile(forkFile, { throwOnError: true }) : undefined
    check(`damaged replay into fork (${kind})`, 'replaying a loaded damaged fold line into a fork lands untouched and loads cleanly', !forkThrew && forkRecords.some(r => r.recordId === keeps.uuid) && isDeepStrictEqual(forkPrior?.payload?.fields?.compactMetadata?.preservedSegment?.keptUuids, badList) && Boolean(forkLoaded?.messages.has(prior.uuid) && forkLoaded?.messages.has(keeps.uuid)))
    start()
    const copyFile = getTranscriptPath()
    let copyThrew = false
    try {
      await recordTranscript([loadedPrior, loadedKeeps])
      await flushSessionStorage()
    } catch { copyThrew = true }
    const copyRecords = existsSync(copyFile) ? readFileSync(copyFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : []
    const copyIds = copyRecords.map(r => r.recordId), copyPrior = copyRecords.find(r => r.recordId === prior.uuid)
    _resetTranscriptReaderForTesting()
    const copyLoaded = existsSync(copyFile) ? await loadTranscriptFile(copyFile, { throwOnError: true }) : undefined
    check(`damaged boundary before row (${kind})`, 'recording a loaded damaged fold line ahead of another row keeps order, leaves keptUuids untouched and loads cleanly', !copyThrew && copyIds.indexOf(prior.uuid) >= 0 && copyIds.indexOf(prior.uuid) < copyIds.indexOf(keeps.uuid) && isDeepStrictEqual(copyPrior?.payload?.fields?.compactMetadata?.preservedSegment?.keptUuids, badList) && Boolean(copyLoaded?.messages.has(prior.uuid) && copyLoaded?.messages.has(keeps.uuid)))
  }
} finally {
  await api.close()
  rmSync(home, { force: true, recursive: true })
}
console.log(`${counts.checks - counts.failures}/${counts.checks} passed`)
process.exit(counts.failures ? 1 : 0)

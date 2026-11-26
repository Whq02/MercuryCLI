#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'resume-live-end-')))
const project = join(scratch, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(project)

const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { createBranchSession } = await import('../../src/sessions/branches/branchManifest.ts')
const { transcriptMessageIndex } = await import('../../src/sessions/transcripts/materialize.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { adoptResumedSessionFile, flushSessionStorage, getTranscriptPath, lastSession, loadTranscriptFile, recordTranscript, resetProjectForTesting } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { replayUpdatesOf, sessionLineOf } = await import('../../src/integrations/acp/server/replay.ts')
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
const { createFoldBoundaryMessage, createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachment-shapes/attachmentMessage.ts')
const { annotateBoundaryWithPreservedSegment } = await import('../../src/engine/compaction/fold/foldResult.ts')
const { SYNTHETIC_MODEL, createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { LEAF_SCENES, LEAF_UNFINISHED_SCENE, writeLeafScene } = await import('../lib/resumeLeafScenes.ts')
import type { LeafScene } from '../lib/resumeLeafScenes.ts'
import type { AssistantMessage, Message } from '../../src/engine/message-shapes/message.ts'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, hint: string, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail.slice(0, 700)}; ` : ''}${hint}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

type Row = { uuid: UUID; type: string; message?: { model?: string; content?: unknown } }
type Seen = { ids: UUID[]; lastTurn: UUID | undefined; interruption?: string; sessionId?: string; told?: { uuid: UUID; meta: boolean }; displaced?: UUID[] | 'none'; leaf?: UUID; replayed?: boolean }
type Source = { id: string; file: string }
type Door = { name: string; hint: string; read: (source: Source, end?: UUID) => Promise<Seen | null> }

const ELECTION = 'electConversationEnd (src/sessions/transcripts/conversationEnd.ts)'
function seenOf(rows: readonly Row[]): Pick<Seen, 'ids' | 'lastTurn'> {
  return {
    ids: rows.map(row => row.uuid),
    lastTurn: rows.findLast(row => row.type === 'user' || (row.type === 'assistant' && row.message?.model !== SYNTHETIC_MODEL))?.uuid,
  }
}
async function resumed(id: string, file: string | undefined): Promise<Seen | null> {
  _resetTranscriptReaderForTesting()
  const loaded = await loadConversationForResume(id, file)
  if (loaded === null) return null
  const told = loaded.turnInterruptionState.kind === 'interrupted_prompt' ? loaded.turnInterruptionState.message.uuid : undefined
  const asked = loaded.turnInterruptionState.kind === 'interrupted_prompt' ? { uuid: loaded.turnInterruptionState.message.uuid, meta: loaded.turnInterruptionState.message.isMeta === true } : undefined
  return { ...seenOf(loaded.messages.filter(row => row.uuid !== told)), interruption: loaded.turnInterruptionState.kind, sessionId: loaded.sessionId, told: asked, displaced: 'displacedNotices' in loaded ? loaded.displacedNotices : 'none' }
}

const pathDoor: Door = {
  name: 'path',
  hint: `walkTranscriptFile in src/sessions/resume/conversationRecovery.ts must take the conversation and its end from ${ELECTION}, never from the newest row of the file`,
  read: source => resumed(source.id, source.file),
}
const idDoor: Door = {
  name: 'id',
  hint: `lastSession in src/sessions/transcripts/sessionListings.ts must take the conversation and its end from ${ELECTION}, never from the newest row of the file`,
  read: source => resumed(source.id, undefined),
}
const idListingDoor: Door = {
  name: 'id listing',
  hint: `lastSession in src/sessions/transcripts/sessionListings.ts must list the rows of ${ELECTION} and anchor leafUuid on the last of them`,
  read: async source => {
    _resetTranscriptReaderForTesting()
    const listing = await lastSession(source.id as UUID)
    return listing === null ? null : { ...seenOf(listing.messages), sessionId: listing.sessionId, leaf: listing.leafUuid }
  },
}
const replayDoor: Door = {
  name: 'ACP replay',
  hint: `sessionLineOf in src/integrations/acp/server/replay.ts must return the rows of ${ELECTION}`,
  read: async (source, end) => {
    _resetTranscriptReaderForTesting()
    const line = sessionLineOf((await loadTranscriptFile(source.file)).messages)
    const content = line.find(row => row.uuid === end)?.message?.content
    const said = Array.isArray(content) ? content.flatMap(block => (block.type === 'text' ? [block.text] : [])) : []
    const replayed = replayUpdatesOf(line).flatMap(update => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []))
    return { ...seenOf(line), replayed: end === undefined ? undefined : said.length > 0 && said.every(text => replayed.includes(text)) }
  },
}
const doors: Door[] = [pathDoor, idDoor, idListingDoor, replayDoor]
const resumeDoors: Door[] = [pathDoor, idDoor]

function endsOnTheLiveEnd(door: Door, scene: LeafScene, seen: Seen | null): void {
  const label = `${scene.name} by ${door.name}`
  if (seen === null) {
    check(`${label}: a conversation is loaded`, false, door.hint, 'the door returned null')
    return
  }
  check(
    `${label}: the conversation ends on its last finished reply, holds the reply before it, and no interruption is invented`,
    seen.lastTurn === scene.end && seen.ids.includes(scene.final) && (seen.interruption ?? 'none') === 'none' && (seen.leaf ?? scene.end) === scene.end && seen.replayed !== false,
    door.hint,
    j({ endsOnEnd: seen.lastTurn === scene.end, hasEnd: seen.ids.includes(scene.end), hasFinal: seen.ids.includes(scene.final), interruption: seen.interruption, leafIsEnd: seen.leaf === undefined ? undefined : seen.leaf === scene.end, replayed: seen.replayed, rows: seen.ids.length }),
  )
  if (scene.summary !== undefined) {
    check(`${label}: the active summary is in the conversation`, seen.ids.includes(scene.summary), door.hint, j({ rows: seen.ids.length }))
  }
  const retained = scene.boundary === undefined || scene.name === 'kept'
  check(
    `${label}: a late result ${retained ? 'stands with its retained call' : 'whose call was folded away is not in the conversation'}, and no row is there twice`,
    scene.reports.every(id => seen.ids.includes(id) === retained) && seen.ids.includes(scene.calls[0]) === retained && new Set(seen.ids).size === seen.ids.length,
    door.hint,
    j({ reports: scene.reports.map(id => seen.ids.includes(id)), call: seen.ids.includes(scene.calls[0]), rows: seen.ids.length, distinct: new Set(seen.ids).size }),
  )
  if (seen.sessionId !== undefined) check(`${label}: the session is the file's own`, seen.sessionId === scene.sid, door.hint, j({ sessionId: seen.sessionId }))
}

function branchAt(scene: LeafScene, last: UUID): Source {
  const branch = createBranchSession({ sourceTranscriptPath: scene.file, forkOrdinal: transcriptMessageIndex(scene.file, last) + 1, boundaryKind: 'rewind', cwd: project, providerOrigin: 'fixture' })
  if (!branch.ok) throw new Error(`the branch of ${scene.name} was not created: ${branch.reason}`)
  return { id: branch.manifest.branchSessionId, file: branch.branchTranscriptPath }
}

console.log('============================================================')
console.log(' a resumed session ends on the live end, by every door')
console.log('============================================================')

try {
  section(`§1 ${LEAF_SCENES.length} written scenes, each read through every door (a path: an explicit .jsonl, run -c, a daemon claim; a bare id; the ACP replay)`)
  for (const name of LEAF_SCENES) {
    const scene = await writeLeafScene(name)
    for (const door of doors) endsOnTheLiveEnd(door, scene, await door.read({ id: scene.sid, file: scene.file }, scene.end))
  }

  section('§2 a copied branch file by its path: the whole record copied, a prefix that stops before the final reply, a branch whose own sitting wrote only a notice')
  for (const name of ['tie-behind', 'fold'] as const) {
    const scene = await writeLeafScene(name)
    const seen = await pathDoor.read(branchAt(scene, scene.reports.at(-1)!))
    endsOnTheLiveEnd({ ...pathDoor, name: 'whole branch copy' }, scene, seen === null ? null : { ...seen, sessionId: undefined })
  }
  {
    const scene = await writeLeafScene('fold')
    const seen = await pathDoor.read(branchAt(scene, scene.summary!))
    check('fold by a prefix that stops at the summary: the copy is not extended — it ends on the summary, without the final reply or the late result', seen !== null && seen.ids.includes(scene.summary!) && !seen.ids.includes(scene.final) && !seen.ids.includes(scene.reports[0]!), pathDoor.hint, j({ rows: seen?.ids.length, hasFinal: seen?.ids.includes(scene.final), hasLate: seen?.ids.includes(scene.reports[0]!) }))
  }
  {
    const scene = await writeLeafScene('plain')
    const branch = branchAt(scene, scene.final)
    _resetTranscriptReaderForTesting()
    const carried = await loadConversationForResume(branch.id, branch.file)
    switchSession(asSessionId(branch.id), dirname(branch.file))
    adoptResumedSessionFile()
    const notice = createSystemMessage('branch sitting notice', 'info')
    await recordTranscript([notice], undefined, [...(carried?.messages ?? []), notice])
    await flushSessionStorage()
    const seen = await pathDoor.read(branch)
    check(
      'a branch copy whose own sitting wrote only a notice under the copied reply: the session is still the branch\'s own, never its source\'s, and the conversation ends on the copied reply',
      seen !== null && seen.sessionId === branch.id && seen.lastTurn === scene.end && (seen.interruption ?? 'none') === 'none',
      'walkTranscriptFile in src/sessions/resume/conversationRecovery.ts must answer with the session of the last row of the elected line: a resume writes into the file of the session it is told',
      j({ sessionId: seen?.sessionId, branch: branch.id, source: scene.sid, endsOnEnd: seen?.lastTurn === scene.end, interruption: seen?.interruption }),
    )
  }

  section('§3 a call the run never answered is still an unfinished turn after a late result, with the summary and the finished reply before it')
  {
    const scene = await writeLeafScene(LEAF_UNFINISHED_SCENE)
    const second = scene.second!
    const wanted = [scene.summary!, scene.final, second.prompt, second.end]
    for (const door of doors) {
      const seen = await door.read({ id: scene.sid, file: scene.file })
      check(
        `unfinished by ${door.name}: the conversation holds the summary, the finished reply, the second prompt and its open call, without the late result, and a resume is told the turn was cut`,
        seen !== null && wanted.every(id => seen.ids.includes(id)) && !seen.ids.includes(scene.reports[0]!) && (seen.interruption ?? 'interrupted_prompt') === 'interrupted_prompt' && (seen.leaf ?? second.end) === second.end,
        door.hint,
        j({ holds: seen === null ? null : wanted.map(id => seen.ids.includes(id)), hasLate: seen?.ids.includes(scene.reports[0]!), interruption: seen?.interruption, leafIsEnd: seen?.leaf === undefined ? undefined : seen.leaf === second.end }),
      )
    }
  }

  section('§4 a file that holds no prompt and no reply elects no end: each door still answers what it answered before the election')
  {
    const NO_TURN = 'when electConversationEnd elects nothing, the door must hand back what it handed back before it read the election: a session an earlier build resumes stays resumable, and one it refuses stays refused'
    let clock = Date.now() - 60_000
    const at = <T extends Message>(row: T): T => {
      row.timestamp = new Date(++clock).toISOString()
      return row
    }
    const sealed = async (behind: (open: AssistantMessage) => Message[]): Promise<Source & { rows: UUID[] }> => {
      resetProjectForTesting()
      _resetTranscriptReaderForTesting()
      const id = randomUUID()
      switchSession(asSessionId(id))
      const open = at(createAssistantMessage({ content: [{ type: 'tool_use', id: 'call_sealed', name: 'Read', input: { file_path: 'fixture' } }] }))
      await recordTranscript([at(createUserMessage({ content: 'fixture turn' })), open])
      await recordTranscript([at(createFoldBoundaryMessage('auto', 1500, open.uuid))])
      const rows = behind(open).map(at)
      for (const row of rows) await recordTranscript([row])
      await flushSessionStorage()
      return { id, file: getTranscriptPath(), rows: rows.map(row => row.uuid) }
    }
    const lone = await sealed(open => [createUserMessage({ sourceToolAssistantUUID: open.uuid, content: [{ type: 'tool_result', tool_use_id: 'call_sealed', content: 'fixture report' }] })])
    for (const door of doors) {
      const seen = await door.read(lone)
      check(
        `a sealed call's result alone behind a fold line whose summary never landed, by ${door.name}: the session is resumed as before, in its own session, as a turn that was cut`,
        seen !== null && seen.ids.includes(lone.rows[0]!) && (seen.sessionId ?? lone.id) === lone.id && (seen.interruption ?? 'interrupted_prompt') !== 'none',
        `${door.hint}; ${NO_TURN}`,
        j({ loaded: seen !== null, rows: seen?.ids.length, hasResult: seen?.ids.includes(lone.rows[0]!), sessionId: seen?.sessionId === lone.id, interruption: seen?.interruption }),
      )
    }
    const alone = await sealed(() => [])
    const noted = await sealed(() => [createSystemMessage('a crew row behind the fold line', 'info')])
    resetProjectForTesting()
    _resetTranscriptReaderForTesting()
    const notes = randomUUID()
    switchSession(asSessionId(notes))
    adoptResumedSessionFile()
    await recordTranscript([at(createSystemMessage('a first note', 'info'))])
    await recordTranscript([at(createSystemMessage('a second note', 'info'))])
    await flushSessionStorage()
    const refused: Array<[string, Source]> = [['a fold line alone', alone], ['a fold line and a crew row', noted], ['notes alone', { id: notes, file: getTranscriptPath() }]]
    for (const [name, source] of refused) {
      for (const door of resumeDoors) check(`${name}, by ${door.name}: refused as before, no conversation is made up`, (await door.read(source)) === null, `${door.hint}; ${NO_TURN}`)
    }
  }

  section('§5 a host notice is written between a call and its result, and the run dies before the reply: the turn is still read as cut; where the notice was the newest row, the reading is what it was')
  {
    const CUT = 'resumeFactsOf in src/sessions/transcripts/sessionListings.ts must name as displacedNotices each host notice (a user row marked isVirtual) that the line places behind a TOOL RESULT written after it in the FILE (never by a stamp; a fold line, a summary or a kept row displaces nothing), and detectInterruption in src/sessions/resume/conversationRecovery.ts must pass over the rows named there and no other, in both of its walks'
    let clock = Date.now() - 30_000
    const at = <T extends Message>(row: T): T => {
      row.timestamp = new Date(++clock).toISOString()
      return row
    }
    type Shape = { calls: number; before: 'notice' | 'two notices' | 'crew row' | 'prompt' | 'nothing'; results: number; reply: boolean; after: 'notice' | 'notice stamped earlier' | 'crew row' | 'quiet attachment' | 'nothing'; cut?: true }
    type Turn = { source: Source; before: UUID[]; after: UUID | undefined; typed: UUID | undefined }
    const turn = async (shape: Shape): Promise<Turn> => {
      resetProjectForTesting()
      _resetTranscriptReaderForTesting()
      const id = randomUUID()
      switchSession(asSessionId(id))
      const issued = Array.from({ length: shape.calls }, (_, index) => {
        const row = at(createAssistantMessage({ content: [{ type: 'tool_use', id: `call_${index}`, name: 'Read', input: { file_path: 'fixture' } }] }))
        row.message.id = 'msg_cut'
        row.message.model = 'claude-sonnet-5'
        row.message.stop_reason = 'tool_use'
        return row
      })
      await recordTranscript([at(createUserMessage({ content: 'fixture turn' })), ...issued])
      const notices = shape.before === 'notice' || shape.before === 'two notices' ? Array.from({ length: shape.before === 'notice' ? 1 : 2 }, () => at(createUserMessage({ content: 'a crewmate finished', isVirtual: true }))) : []
      for (const notice of notices) await recordTranscript([notice])
      const typed = shape.before === 'prompt' ? at(createUserMessage({ content: 'a prompt typed while the call ran' })) : undefined
      if (typed !== undefined) await recordTranscript([typed])
      if (shape.before === 'crew row') await recordTranscript([at(createSystemMessage('a crew row', 'info'))])
      for (const [index, row] of issued.slice(0, shape.results).entries()) await recordTranscript([at(createUserMessage({ sourceToolAssistantUUID: row.uuid, content: [{ type: 'tool_result', tool_use_id: `call_${index}`, ...(shape.cut === true ? { is_error: true, content: 'Cut off: the operator stopped the turn' } : { content: 'fixture report' }) }] }))])
      if (shape.reply) {
        const reply = at(createAssistantMessage({ content: 'finished fixture reply' }))
        reply.message.model = 'claude-sonnet-5'
        reply.message.stop_reason = 'end_turn'
        await recordTranscript([reply])
      }
      const trailing = shape.after === 'notice' || shape.after === 'notice stamped earlier' ? at(createUserMessage({ content: 'a crewmate finished later', isVirtual: true })) : undefined
      if (trailing !== undefined && shape.after === 'notice stamped earlier') trailing.timestamp = new Date(clock - 20_000).toISOString()
      if (trailing !== undefined) await recordTranscript([trailing])
      if (shape.after === 'crew row') await recordTranscript([at(createSystemMessage('a crew row behind the result', 'info'))])
      if (shape.after === 'quiet attachment') await recordTranscript([at(createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: 'msg_cut', blockIndex: 0 }] }))])
      await flushSessionStorage()
      return { source: { id, file: getTranscriptPath() }, before: notices.map(row => row.uuid), after: trailing?.uuid, typed: typed?.uuid }
    }
    const cutShapes: Array<[string, Shape]> = [
      ['one call, a host notice before its result, no reply', { calls: 1, before: 'notice', results: 1, reply: false, after: 'nothing' }],
      ['two parallel calls, a host notice before their results, no reply', { calls: 2, before: 'notice', results: 2, reply: false, after: 'nothing' }],
      ['one call, two host notices before its result, no reply', { calls: 1, before: 'two notices', results: 1, reply: false, after: 'nothing' }],
      ['one call, a host notice before its result, a crew row behind it, no reply', { calls: 1, before: 'notice', results: 1, reply: false, after: 'crew row' }],
    ]
    for (const [name, shape] of cutShapes) {
      const cut = await turn(shape)
      for (const door of resumeDoors) {
        const seen = await door.read(cut.source)
        check(
          `${name}, by ${door.name}: the resume is told the turn was cut, by the sentence the product adds and not by a notice`,
          seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.meta === true && !cut.before.includes(seen.told.uuid) && j(seen.displaced) === j(cut.before),
          CUT,
          j({ interruption: seen?.interruption, toldByTheProductsSentence: seen?.told?.meta, toldIsANotice: seen?.told === undefined ? undefined : cut.before.includes(seen.told.uuid), namedDisplaced: j(seen?.displaced) === j(cut.before) }),
        )
      }
    }
    const plain = await pathDoor.read((await turn({ calls: 1, before: 'nothing', results: 1, reply: false, after: 'nothing' })).source)
    const crewed = await pathDoor.read((await turn({ calls: 1, before: 'crew row', results: 1, reply: false, after: 'nothing' })).source)
    check('controls, by path: the same cut with no notice, and with a crew row in its place, are told as cut, and a file with no such notice is handed no fact about one', [plain, crewed].every(seen => seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.meta === true && seen.displaced === 'none'), CUT, j([plain, crewed].map(seen => ({ interruption: seen?.interruption, meta: seen?.told?.meta, displaced: seen?.displaced }))))
    const done = await pathDoor.read((await turn({ calls: 1, before: 'notice', results: 1, reply: true, after: 'nothing' })).source)
    check('control, by path: the turn finished with the notice in it: no interruption', done !== null && done.interruption === 'none', CUT, j({ interruption: done?.interruption }))
    const typed = await turn({ calls: 1, before: 'prompt', results: 1, reply: false, after: 'nothing' })
    const asked = await pathDoor.read(typed.source)
    check('control, by path: a real prompt typed between a call and its result, the run cut before the reply, is still the prompt nobody answered', asked !== null && asked.interruption === 'interrupted_prompt' && asked.told?.uuid === typed.typed && asked.told?.meta === false, CUT, j({ interruption: asked?.interruption, toldIsThePrompt: asked?.told?.uuid === typed.typed, meta: asked?.told?.meta }))
    for (const before of ['notice', 'nothing'] as const) {
      const stopped = await pathDoor.read((await turn({ calls: 1, before, results: 1, reply: false, after: 'quiet attachment', cut: true })).source)
      check(`control, by path: the operator stopped the turn (the call's result says so), ${before === 'notice' ? 'a host notice before that result' : 'no notice'}, an attachment that asks no reply behind it: the cut was told once already and no sentence is added`, stopped !== null && stopped.interruption === 'none', CUT, j({ interruption: stopped?.interruption, displaced: stopped?.displaced === 'none' ? 'none' : stopped?.displaced?.length }))
    }
    {
      const ask = (): Message => createUserMessage({ content: 'kept fixture turn' })
      const issue = (index: number): AssistantMessage => {
        const row = createAssistantMessage({ content: [{ type: 'tool_use', id: `kept_${index}`, name: 'Read', input: { file_path: 'fixture' } }] })
        row.message.id = 'msg_kept'
        row.message.model = 'claude-sonnet-5'
        row.message.stop_reason = 'tool_use'
        return row
      }
      const answer = (issued: AssistantMessage, index: number): Message => createUserMessage({ sourceToolAssistantUUID: issued.uuid, content: [{ type: 'tool_result', tool_use_id: `kept_${index}`, content: 'fixture report' }] })
      const hostNotice = (): Message => createUserMessage({ content: 'a crewmate finished', isVirtual: true })
      const finished = (): AssistantMessage => {
        const row = createAssistantMessage({ content: 'finished fixture reply' })
        row.message.model = 'claude-sonnet-5'
        row.message.stop_reason = 'end_turn'
        return row
      }
      const keptFold = async (batches: Message[][], behind: Message[] = []): Promise<Source> => {
        resetProjectForTesting()
        _resetTranscriptReaderForTesting()
        const id = randomUUID()
        switchSession(asSessionId(id))
        for (const batch of batches) await recordTranscript(batch.map(at))
        const kept = batches.flat()
        const boundary = at(createFoldBoundaryMessage('auto', 1500, kept.at(-1)!.uuid))
        const summary = at(createUserMessage({ content: 'active summary', isCompactSummary: true }))
        annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
        await recordTranscript([boundary])
        await recordTranscript([summary])
        for (const row of behind) await recordTranscript([at(row)])
        await flushSessionStorage()
        return { id, file: getTranscriptPath() }
      }
      const KEPT = 'a fold keeps the turn and the run dies before the reply'
      {
        const call = issue(0), notice = hostNotice()
        const seen = await pathDoor.read(await keptFold([[ask(), call], [answer(call, 0)], [notice]]))
        check(`${KEPT}; the host notice was written BEHIND the result: it was the newest row, so the reading stops on it as before and no sentence is added, though the fold line and the summary were written after it`, seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.uuid === notice.uuid && seen.displaced === 'none', CUT, j({ interruption: seen?.interruption, toldIsTheNotice: seen?.told?.uuid === notice.uuid, meta: seen?.told?.meta, displaced: seen?.displaced === 'none' ? 'none' : seen?.displaced?.length }))
      }
      {
        const first = issue(0), second = issue(1), notice = hostNotice()
        const seen = await pathDoor.read(await keptFold([[ask(), first, second], [answer(first, 0)], [notice]]))
        check(`${KEPT}; one of two calls answered, then the host notice: read as before, on the notice`, seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.uuid === notice.uuid && seen.displaced === 'none', CUT, j({ interruption: seen?.interruption, toldIsTheNotice: seen?.told?.uuid === notice.uuid, displaced: seen?.displaced === 'none' ? 'none' : seen?.displaced?.length }))
      }
      {
        const call = issue(0), notice = hostNotice()
        const seen = await pathDoor.read(await keptFold([[ask(), call], [answer(call, 0)], [finished()], [notice]]))
        check('a fold keeps a finished turn and the host notice written behind its reply: read as before, on the notice', seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.uuid === notice.uuid && seen.displaced === 'none', CUT, j({ interruption: seen?.interruption, toldIsTheNotice: seen?.told?.uuid === notice.uuid, displaced: seen?.displaced === 'none' ? 'none' : seen?.displaced?.length }))
      }
      {
        const call = issue(0)
        const seen = await pathDoor.read(await keptFold([[ask(), call], [answer(call, 0)], [hostNotice()]], [finished()]))
        check('a fold keeps the turn with a host notice behind its result, and the reply lands after the fold: no interruption', seen !== null && seen.interruption === 'none', CUT, j({ interruption: seen?.interruption }))
      }
      {
        const call = issue(0), notice = hostNotice()
        const seen = await pathDoor.read(await keptFold([[ask(), call], [notice], [answer(call, 0)]]))
        check(`${KEPT}; the host notice was written BEFORE the result: the resume is told the turn was cut, by the sentence the product adds`, seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.meta === true && seen.told.uuid !== notice.uuid, CUT, j({ interruption: seen?.interruption, toldByTheProductsSentence: seen?.told?.meta, toldIsTheNotice: seen?.told?.uuid === notice.uuid }))
      }
    }
    {
      resetProjectForTesting()
      _resetTranscriptReaderForTesting()
      const id = randomUUID()
      switchSession(asSessionId(id))
      const calls = [0, 1].map(index => {
        const row = at(createAssistantMessage({ content: [{ type: 'tool_use', id: `late_${index}`, name: 'Read', input: { file_path: 'fixture' } }] }))
        row.message.id = 'msg_late'
        row.message.model = 'claude-sonnet-5'
        row.message.stop_reason = 'tool_use'
        return row
      })
      await recordTranscript([at(createUserMessage({ content: 'fixture turn' })), ...calls])
      await recordTranscript([at(createUserMessage({ sourceToolAssistantUUID: calls[1]!.uuid, content: [{ type: 'tool_result', tool_use_id: 'late_1', content: 'fixture report' }] }))])
      const reply = at(createAssistantMessage({ content: 'finished fixture reply' }))
      reply.message.model = 'claude-sonnet-5'
      reply.message.stop_reason = 'end_turn'
      await recordTranscript([reply])
      await recordTranscript([at(createUserMessage({ content: 'a crewmate finished at idle', isVirtual: true }))])
      await recordTranscript([at(createUserMessage({ sourceToolAssistantUUID: calls[0]!.uuid, content: [{ type: 'tool_result', tool_use_id: 'late_0', content: 'fixture report' }] }))])
      await flushSessionStorage()
      const seen = await pathDoor.read({ id, file: getTranscriptPath() })
      check('a host notice at idle behind a finished reply, then a late result of that turn: no sentence is added', seen !== null && seen.told?.meta !== true && seen.ids.includes(reply.uuid), CUT, j({ interruption: seen?.interruption, meta: seen?.told?.meta, hasReply: seen?.ids.includes(reply.uuid) }))
    }
    const newest: Array<[string, Shape]> = [
      ['a host notice behind a finished reply', { calls: 1, before: 'nothing', results: 1, reply: true, after: 'notice' }],
      ['a second host notice behind the result, no reply', { calls: 1, before: 'notice', results: 1, reply: false, after: 'notice' }],
      ['a host notice written behind the result and stamped before it (its board event\'s own time)', { calls: 1, before: 'nothing', results: 1, reply: false, after: 'notice stamped earlier' }],
      ['a host notice behind a call that was never answered', { calls: 1, before: 'nothing', results: 0, reply: false, after: 'notice' }],
      ['two calls, one result, then a host notice, the other call open', { calls: 2, before: 'nothing', results: 1, reply: false, after: 'notice' }],
    ]
    for (const [name, shape] of newest) {
      const scene = await turn(shape)
      const seen = await pathDoor.read(scene.source)
      check(`control, by path: ${name}: the notice was the newest row, so the reading stops on it as before and no sentence is added`, seen !== null && seen.interruption === 'interrupted_prompt' && seen.told?.uuid === scene.after && seen.told?.meta === false && !(Array.isArray(seen.displaced) && seen.displaced.includes(scene.after!)), CUT, j({ interruption: seen?.interruption, toldIsTheNotice: seen?.told?.uuid === scene.after, meta: seen?.told?.meta, displaced: seen?.displaced === 'none' ? 'none' : seen?.displaced?.length }))
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ A RESUMED SESSION ENDS ON THE LIVE END (${checks} checks)` : ` ❌ ${failures} of ${checks} RESUME-END CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

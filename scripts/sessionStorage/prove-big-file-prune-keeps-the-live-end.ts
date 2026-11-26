#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'big-file-live-end-')))
const project = join(scratch, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_RESUME_SNAPSHOT = '0'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(project)

const { flushSessionStorage, recordTranscript } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { appendEntryToFile } = await import('../../src/sessions/transcripts/writer.ts')
const { loadTranscriptFile, pruneRecordBranchesBeforeParse } = await import('../../src/sessions/transcripts/loading.ts')
const { SKIP_BEFORE_FOLD_BOUNDARY_THRESHOLD } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const { choose, electConversationEnd, pointOf } = await import('../../src/sessions/transcripts/conversationEnd.ts')
const { indexLine } = await import('../../src/sessions/transcripts/branchSelection.ts')
const { readRecordFact } = await import('../../src/sessions/transcripts/recordFacts.ts')
const { transcriptRowOrder } = await import('../../src/sessions/transcripts/rowGraph.ts')
const { SNAPSHOT_SCHEMA, snapshotPathFor, tryLoadResumeSnapshot } = await import('../../src/sessions/transcripts/resumeSnapshot.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { decodeTranscriptBuffer } = await import('../../src/sessions/fabric/transcriptDecode.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { writeLeafScene } = await import('../lib/resumeLeafScenes.ts')
import type { AssistantMessage, Message, UserMessage } from '../../src/engine/message-shapes/message.ts'
import type { TranscriptMessage } from '../../src/sessions/transcripts/transcriptEntries.ts'
import type { LeafScene } from '../lib/resumeLeafScenes.ts'

let checks = 0
let failures = 0
const HINT =
  'selectBranchIds in src/sessions/transcripts/branchSelection.ts must take the end from the election of src/sessions/transcripts/conversationEnd.ts and keep every row that election and its screen read: the spine, the late result a spine row was written under, and every row whose parents never reach the spine'
const FACT_HINT =
  'writtenFact in src/sessions/transcripts/recordFacts.ts must answer the fact of the decoded row (pointOf in src/sessions/transcripts/conversationEnd.ts) or decline the line, so that the row is decoded'
const KEPT_HINT =
  'selectBranchIds in src/sessions/transcripts/branchSelection.ts must prune nothing when the fold line the election stands behind keeps rows: in the file those rows hang beside the line, and only the loader moves them'
function check(label: string, ok: boolean, detail = '', hint = HINT): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail.slice(0, 700)}; ` : ''}${hint}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const MIB = 1024 * 1024
let clock = Date.now() - 60_000
const stamped = <T extends Message>(row: T, at = ++clock): T => {
  row.timestamp = new Date(at).toISOString()
  return row
}
const prompt = (text: string, at?: number): UserMessage => stamped(createUserMessage({ content: text }), at)
const reply = (text: string): AssistantMessage => {
  const row = stamped(createAssistantMessage({ content: text }))
  row.message.model = 'claude-sonnet-5'
  row.message.stop_reason = 'end_turn'
  return row
}
const call = (id: string, group: string, at?: number): AssistantMessage => {
  const row = stamped(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'fixture' } }] }), at)
  row.message.id = group
  row.message.model = 'claude-sonnet-5'
  row.message.stop_reason = 'tool_use'
  return row
}
const report = (id: string, issuer: AssistantMessage): UserMessage =>
  stamped(createUserMessage({ sourceToolAssistantUUID: issuer.uuid, content: [{ type: 'tool_result', tool_use_id: id, content: 'fixture report' }] }))
function hang(scene: LeafScene, row: { uuid: UUID }, parent: UUID, thread: { isSidechain: boolean; agentId?: string } = { isSidechain: false }): void {
  appendEntryToFile(scene.file, { parentUuid: parent, ...thread, ...row, cwd: project, sessionId: scene.sid, version: '1.1.1' })
}
const abandonedBefore = Date.now() - 600_000

type Loaded = Awaited<ReturnType<typeof loadTranscriptFile>>
async function read(file: string, whole: boolean): Promise<Loaded> {
  _resetTranscriptReaderForTesting()
  return loadTranscriptFile(file, whole ? { keepAllLeaves: true, throwOnError: true } : { throwOnError: true })
}
type Ends = { primary: UUID | undefined; rows: UUID[]; screen: UUID[] }
function endsOf(loaded: Loaded): Ends {
  const elected = electConversationEnd(loaded.messages)
  return { primary: elected?.primary.uuid, rows: elected?.rows.map(row => row.uuid) ?? [], screen: elected?.screenRows.map(row => row.uuid) ?? [] }
}
function electedParents(loaded: Loaded): (row: TranscriptMessage) => UUID | null {
  const voters = transcriptRowOrder(loaded.messages).flatMap(id => loaded.messages.get(id) ?? []).filter(row => !row.isSidechain)
  const relinks = choose(voters.map(pointOf))?.relinks
  return row => relinks?.get(row.uuid) ?? row.parentUuid
}
function factsAgree(label: string, file: string): void {
  const raw = readFileSync(file)
  let at = 0
  let position = 0
  const differing: string[] = []
  while (at < raw.length) {
    const to = raw.indexOf(10, at) + 1
    const line = raw.subarray(at, to)
    at = to
    const id = indexLine(line, 0).id
    const row = decodeTranscriptBuffer<TranscriptMessage>(line).entries[0]
    if (id === null || row === undefined || row.type === 'progress') continue
    const fact = readRecordFact(id, line, position)
    const decoded = pointOf(row, position)
    const same = fact?.kind === 'voter' && fact.sidechain === Boolean(row.isSidechain) && fact.assistant === (row.type === 'assistant') && Object.keys(decoded).length === Object.keys(fact.point).length && Object.entries(decoded).every(([key, value]) => j(value) === j(Object.entries(fact.point).find(([name]) => name === key)?.[1]))
    if (!same) differing.push(id)
    position++
  }
  check(`${label}: every record's fact read from its bytes is the fact of its decoded row`, position > 0 && differing.length === 0, j({ rows: position, differing: differing.length }), FACT_HINT)
}
async function acrossThePrune(label: string, file: string): Promise<{ whole: Loaded; planned: Loaded; full: Ends; pruned: Ends }> {
  const whole = await read(file, true)
  const planned = await read(file, false)
  const full = endsOf(whole)
  const pruned = endsOf(planned)
  check(`${label}: the file is over the 5 MB gate`, statSync(file).size > SKIP_BEFORE_FOLD_BOUNDARY_THRESHOLD, String(statSync(file).size))
  factsAgree(label, file)
  const parentOf = electedParents(whole)
  const cut = [...planned.messages.values()].filter(row => !row.isSidechain).filter(row => {
    const parent = parentOf(row)
    return parent !== null && whole.messages.has(parent) && !planned.messages.has(parent)
  })
  check(`${label}: no row the pruned read holds has an elected parent that the file holds and the pruned read does not`, cut.length === 0, j({ cut: cut.length, held: planned.messages.size }))
  check(
    `${label}: the read that may prune elects the same end, the same resume rows and the same screen rows as the read of every row`,
    full.primary !== undefined && full.primary === pruned.primary && j(full.rows) === j(pruned.rows) && j(full.screen) === j(pruned.screen),
    j({ sameEnd: full.primary === pruned.primary, rows: [full.rows.length, pruned.rows.length], screen: [full.screen.length, pruned.screen.length], held: [whole.messages.size, planned.messages.size] }),
  )
  return { whole, planned, full, pruned }
}

console.log('============================================================')
console.log(' a file over 5 MB is pruned around the elected end')
console.log('============================================================')

try {
  section('§1 a fold, a summary over 5 MB, the reply, then a late result whose call was sealed away')
  {
    const scene = await writeLeafScene('large')
    const late = scene.reports[0]!
    const { planned, pruned } = await acrossThePrune('large', scene.file)
    check('large: the read that may prune holds the boundary, the summary, the reply and the late result', [scene.boundary!, scene.summary!, scene.final, late].every(id => planned.messages.has(id)), j({ held: planned.messages.size, has: [scene.boundary!, scene.summary!, scene.final, late].map(id => planned.messages.has(id)) }))
    check('large: the end is the reply; the resume holds the summary and not the unowned result; the screen shows that result once', pruned.primary === scene.final && pruned.rows.includes(scene.summary!) && !pruned.rows.includes(late) && pruned.screen.filter(id => id === late).length === 1, j({ end: pruned.primary === scene.final, rows: pruned.rows.length, screen: pruned.screen.length }))
    const raw = readFileSync(scene.file)
    check('large: nothing in it is an abandoned branch, so the bytes come back untouched', pruneRecordBranchesBeforeParse(raw) === raw)
  }

  section('§2 the same file after the session went on: a prompt written under the late result, and its reply')
  {
    const scene = await writeLeafScene('large')
    const again = prompt('second fixture turn')
    const answered = reply('second fixture reply')
    await recordTranscript([again])
    await recordTranscript([answered])
    await flushSessionStorage()
    const { planned, pruned } = await acrossThePrune('large, gone on', scene.file)
    check('large, gone on: the prompt was written under the late result', planned.messages.get(again.uuid)?.parentUuid === scene.reports[0], j({ parent: planned.messages.get(again.uuid)?.parentUuid }))
    check('large, gone on: the end is the second reply, behind the summary, the first reply and the second prompt', pruned.primary === answered.uuid && j(pruned.rows.filter(id => [scene.summary!, scene.final, again.uuid, answered.uuid].includes(id))) === j([scene.summary!, scene.final, again.uuid, answered.uuid]) && !pruned.rows.includes(scene.reports[0]!), j({ end: pruned.primary === answered.uuid, rows: pruned.rows.length }))
    const raw = readFileSync(scene.file)
    check('large, gone on: still nothing is abandoned, so the bytes come back untouched', pruneRecordBranchesBeforeParse(raw) === raw)
  }

  section('§3 no fold: a result landed at the reply\'s own millisecond behind it, and an abandoned 6 MB prompt hangs off the first prompt')
  let tied: { scene: LeafScene; dead: UUID }
  {
    const scene = await writeLeafScene('tie-behind')
    const dead = prompt(`abandoned paste ${'x'.repeat(6 * MIB)}`, abandonedBefore)
    hang(scene, dead, scene.prompt)
    const lost = report('call_lost', call('call_lost', 'msg_lost'))
    hang(scene, lost, lost.sourceToolAssistantUUID!)
    tied = { scene, dead: dead.uuid }
    const { whole, planned, pruned } = await acrossThePrune('tie-behind with a dead branch', scene.file)
    check('tie-behind with a dead branch: the abandoned prompt is read by the whole read and never parsed by the pruned one', whole.messages.has(dead.uuid) && !planned.messages.has(dead.uuid), j({ whole: whole.messages.has(dead.uuid), planned: planned.messages.has(dead.uuid) }))
    check('tie-behind with a dead branch: with no fold in the file, a result whose call the file never held is read by nobody and is not kept', whole.messages.has(lost.uuid) && !planned.messages.has(lost.uuid), j({ whole: whole.messages.has(lost.uuid), planned: planned.messages.has(lost.uuid) }))
    check('tie-behind with a dead branch: the end is the reply, with both results before it', pruned.primary === scene.final && scene.reports.every(id => pruned.rows.includes(id) && pruned.rows.indexOf(id) < pruned.rows.indexOf(scene.final)), j({ end: pruned.primary === scene.final, reports: scene.reports.map(id => pruned.rows.includes(id)) }))
  }

  section('§4 a call on a branch that was rewound away reports late, and the session goes on under that result; a second, 6 MB branch is plainly abandoned')
  {
    const scene = await writeLeafScene('plain')
    const dead = prompt(`abandoned paste ${'x'.repeat(6 * MIB)}`, abandonedBefore)
    hang(scene, dead, scene.prompt)
    const rewound = prompt(`rewound prompt ${'y'.repeat(MIB)}`)
    const open = call('call_rewound', 'msg_rewound')
    hang(scene, rewound, scene.final)
    hang(scene, open, rewound.uuid)
    const kept = prompt('the prompt written after the rewind')
    const keptReply = reply('its reply')
    hang(scene, kept, scene.final)
    hang(scene, keptReply, kept.uuid)
    const late = report('call_rewound', open)
    hang(scene, late, open.uuid)
    const next = prompt('the prompt written under the late result')
    const nextReply = reply('the last reply')
    hang(scene, next, late.uuid)
    hang(scene, nextReply, next.uuid)
    const { whole, planned, pruned } = await acrossThePrune('late result of a rewound call', scene.file)
    check('late result of a rewound call: the plainly abandoned 6 MB prompt is never parsed, and the result the session went on under is', whole.messages.has(dead.uuid) && !planned.messages.has(dead.uuid) && planned.messages.has(late.uuid), j({ dead: planned.messages.has(dead.uuid), late: planned.messages.has(late.uuid), held: [whole.messages.size, planned.messages.size] }))
    check('late result of a rewound call: the conversation is the kept line and the turn written after the result, in that order', pruned.primary === nextReply.uuid && j(pruned.rows.filter(id => [kept.uuid, keptReply.uuid, next.uuid, nextReply.uuid, rewound.uuid].includes(id))) === j([kept.uuid, keptReply.uuid, next.uuid, nextReply.uuid]), j({ end: pruned.primary === nextReply.uuid, rows: pruned.rows.length }))
  }

  section('§5 a fold; a branch rewound to the summary takes a late result and a turn under it; then the session is rewound to the first reply and goes on')
  {
    const scene = await writeLeafScene('fold')
    const rewound = prompt(`rewound prompt ${'y'.repeat(6 * MIB)}`)
    const rewoundReply = reply('the reply of the rewound branch')
    hang(scene, rewound, scene.summary!)
    hang(scene, rewoundReply, rewound.uuid)
    const late = report('call_b', call('call_b', 'msg_leaf'))
    late.sourceToolAssistantUUID = scene.calls[1]
    hang(scene, late, scene.calls[1])
    const under = prompt('a prompt written under the late result, on the branch then live')
    const underReply = reply('its reply')
    hang(scene, under, late.uuid)
    hang(scene, underReply, under.uuid)
    const side = { ...prompt(`a crewmate's row ${'z'.repeat(MIB)}`), agentId: 'peer' }
    hang(scene, side, scene.calls[0], { isSidechain: true, agentId: 'peer' })
    const kept = prompt('the prompt written after the rewind to the first reply')
    const working = { type: 'progress', uuid: randomUUID(), timestamp: new Date(++clock).toISOString(), toolUseID: 'call_progress', data: { type: 'bash_progress' } } as const
    const keptReply = reply('the last reply')
    hang(scene, kept, scene.final)
    hang(scene, working, kept.uuid)
    hang(scene, keptReply, working.uuid)
    const note = stamped(createSystemMessage('a note behind the last reply', 'info'))
    hang(scene, note, keptReply.uuid)
    const { whole, planned, pruned } = await acrossThePrune('a late result on a branch later abandoned', scene.file)
    check(
      'a late result on a branch later abandoned: the rewound branch goes whole, the turn written under the late result with it; both late results stay for the screen; the crewmate\'s row is not kept',
      [rewound.uuid, rewoundReply.uuid, under.uuid, underReply.uuid].every(id => whole.messages.has(id) && !planned.messages.has(id)) && [late.uuid, scene.reports[0]!].every(id => planned.messages.has(id) && pruned.screen.includes(id)) && whole.messages.has(side.uuid) && !planned.messages.has(side.uuid),
      j({ gone: [rewound.uuid, rewoundReply.uuid, under.uuid, underReply.uuid].map(id => !planned.messages.has(id)), late: [late.uuid, scene.reports[0]!].map(id => planned.messages.has(id)), side: planned.messages.has(side.uuid), held: [whole.messages.size, planned.messages.size] }),
    )
    check('a late result on a branch later abandoned: the end is the last reply, read across the progress row the file holds between it and its prompt, with the note behind it', pruned.primary === keptReply.uuid && planned.messages.get(keptReply.uuid)?.parentUuid === kept.uuid && j(pruned.rows.slice(-3)) === j([kept.uuid, keptReply.uuid, note.uuid]), j({ end: pruned.primary === keptReply.uuid, parent: planned.messages.get(keptReply.uuid)?.parentUuid === kept.uuid, tail: pruned.rows.slice(-3).length }))
  }

  section('§6 a fold; a prompt whose parent row the file lost was written on a branch that was later left; the session goes on from the first reply')
  {
    const scene = await writeLeafScene('fold')
    const dead = prompt(`abandoned paste ${'x'.repeat(6 * MIB)}`, abandonedBefore)
    hang(scene, dead, scene.summary!)
    const left = prompt(`a prompt on the branch left behind ${'y'.repeat(MIB)}`)
    const leftReply = reply('its reply')
    hang(scene, left, scene.summary!)
    hang(scene, leftReply, left.uuid)
    const orphan = prompt('a prompt whose parent row the file does not hold')
    const orphanReply = reply('its reply')
    hang(scene, orphan, randomUUID())
    hang(scene, orphanReply, orphan.uuid)
    const kept = prompt('the prompt written after the rewind to the first reply')
    const keptReply = reply('the last reply')
    hang(scene, kept, scene.final)
    hang(scene, keptReply, kept.uuid)
    const { whole, planned, pruned } = await acrossThePrune('a lost parent on a branch left behind', scene.file)
    check(
      'a lost parent on a branch left behind: the screen still shows the two rows where they were written, so they are kept, and with them the branch the writer stood on; the plainly abandoned prompt is not parsed',
      pruned.primary === keptReply.uuid && [orphan.uuid, orphanReply.uuid].every(id => pruned.screen.includes(id) && !pruned.rows.includes(id)) && [left.uuid, leftReply.uuid].every(id => planned.messages.has(id)) && whole.messages.has(dead.uuid) && !planned.messages.has(dead.uuid),
      j({ end: pruned.primary === keptReply.uuid, shown: [orphan.uuid, orphanReply.uuid].map(id => pruned.screen.includes(id)), stood: [left.uuid, leftReply.uuid].map(id => planned.messages.has(id)), dead: planned.messages.has(dead.uuid) }),
    )
  }

  section('§7 a clock set back: an open call carries the newest stamp, a branch written after it is abandoned, and the call\'s result landed while the writer stood on that branch')
  {
    const scene = await writeLeafScene('plain')
    const dead = prompt(`abandoned paste ${'x'.repeat(6 * MIB)}`, abandonedBefore)
    hang(scene, dead, scene.prompt)
    const open = call('call_ahead', 'msg_ahead', Date.now() - 1_000)
    hang(scene, open, scene.final)
    const left = prompt(`a prompt on the branch left behind ${'y'.repeat(MIB)}`, abandonedBefore + 1)
    const leftReply = reply('its reply')
    leftReply.timestamp = new Date(abandonedBefore + 2).toISOString()
    hang(scene, left, scene.final)
    hang(scene, leftReply, left.uuid)
    const late = report('call_ahead', open)
    hang(scene, late, open.uuid)
    const { whole, planned, pruned } = await acrossThePrune('a kept late result', scene.file)
    check(
      'a kept late result: the row the writer stood on when it landed is kept with its branch, so the result still reads late and the open call is still the end; the plainly abandoned prompt is not parsed',
      pruned.primary === open.uuid && pruned.rows.at(-1) === late.uuid && [left.uuid, leftReply.uuid].every(id => planned.messages.has(id)) && whole.messages.has(dead.uuid) && !planned.messages.has(dead.uuid),
      j({ end: pruned.primary === open.uuid, last: pruned.rows.at(-1) === late.uuid, stood: [left.uuid, leftReply.uuid].map(id => planned.messages.has(id)), dead: planned.messages.has(dead.uuid) }),
    )
  }

  section('§8 the 6 MB abandoned prompt is never parsed: its bytes can be broken and its fact still reads; records whose link fields stand in another order keep the same rows')
  {
    const raw = readFileSync(tied.scene.file)
    const kept = (buffer: Buffer): string[] => decodeTranscriptBuffer<{ uuid?: string }>(pruneRecordBranchesBeforeParse(buffer)).entries.flatMap(entry => (typeof entry.uuid === 'string' ? [entry.uuid] : []))
    const lastFirst = (fields: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(fields).reverse())
    const reordered = Buffer.from(
      raw
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const record = JSON.parse(line) as { annotations?: Record<string, unknown>; payload: { fields?: Record<string, unknown> } }
          if (record.annotations !== undefined) record.annotations = lastFirst(record.annotations)
          if (record.payload.fields !== undefined) record.payload.fields = lastFirst(record.payload.fields)
          return `${JSON.stringify(record)}\n`
        })
        .join(''),
    )
    const lines: Buffer[] = []
    for (let at = 0; at < raw.length; at = raw.indexOf(10, at) + 1) lines.push(raw.subarray(at, raw.indexOf(10, at) + 1))
    const fat = lines.find(line => indexLine(line, 0).id === tied.dead)!
    const broken = Buffer.from(fat)
    broken[Math.floor(broken.length / 2)] = 1
    check('broken bytes: the abandoned prompt\'s record no longer decodes, and its fact is read all the same', decodeTranscriptBuffer(broken).entries.length === 0 && j(readRecordFact(tied.dead, broken, 7)) === j(readRecordFact(tied.dead, fat, 7)) && readRecordFact(tied.dead, fat, 7)?.kind === 'voter', j({ decodes: decodeTranscriptBuffer(broken).entries.length, fact: readRecordFact(tied.dead, broken, 7)?.kind }))
    const canonical = kept(raw)
    check('reordered link fields: the same rows are kept, the reply among them and the abandoned prompt not', canonical.length > 0 && j(canonical) === j(kept(reordered)) && canonical.includes(tied.scene.final) && !canonical.includes(tied.dead), j({ canonical: canonical.length, reordered: kept(reordered).length }))
  }

  section('§9 a fold that keeps rows, its kept head the file\'s first row, then a 6 MB branch that was left behind: the seal wrote that head with its parent behind its annotations')
  {
    const scene = await writeLeafScene('kept')
    const dead = prompt(`abandoned paste ${'x'.repeat(6 * MIB)}`)
    const deadReply = reply('the reply of the branch left behind')
    hang(scene, dead, scene.final)
    hang(scene, deadReply, dead.uuid)
    const kept = prompt('the prompt written after the rewind to the first reply')
    const keptReply = reply('the last reply')
    hang(scene, kept, scene.final)
    hang(scene, keptReply, kept.uuid)
    const raw = readFileSync(scene.file)
    const relinked = raw
      .toString('latin1')
      .split('\n')
      .filter(line => line.includes(',"annotations":{') && line.lastIndexOf(',"parentId":"') > line.lastIndexOf(',"annotations":{'))
    check('a kept fold: the scene holds the row this section is about, the kept prompt with its parent written last', relinked.length === 1 && indexLine(Buffer.from(relinked[0]!, 'latin1'), 0).id === scene.prompt, j({ lines: relinked.length }), 'writeLeafScene(\'kept\') in scripts/lib/resumeLeafScenes.ts must keep the file\'s first row behind its fold, so that the seal relinks it')
    factsAgree('a kept fold', scene.file)
    const handed = pruneRecordBranchesBeforeParse(raw)
    const left = decodeTranscriptBuffer<{ uuid?: string }>(handed).entries.flatMap(entry => (typeof entry.uuid === 'string' ? [entry.uuid] : []))
    check(
      'a kept fold: the planner called on the file itself cuts nothing, so the kept prompt and its calls are still there',
      raw.length > SKIP_BEFORE_FOLD_BOUNDARY_THRESHOLD && handed === raw && [scene.prompt, ...scene.calls].every(id => left.includes(id)),
      j({ bytes: [raw.length, handed.length], kept: [scene.prompt, ...scene.calls].map(id => left.includes(id)), dead: left.includes(dead.uuid) }),
      KEPT_HINT,
    )
    const full = endsOf(await read(scene.file, true))
    const planned = endsOf(await read(scene.file, false))
    check(
      'a kept fold: the default read elects the end, the resume rows and the screen rows of the whole read, the kept prompt before the last reply',
      full.primary === keptReply.uuid && j(full) === j(planned) && planned.rows.includes(scene.prompt) && planned.rows.indexOf(scene.prompt) < planned.rows.indexOf(keptReply.uuid) && !planned.rows.includes(dead.uuid),
      j({ end: planned.primary === keptReply.uuid, rows: [full.rows.length, planned.rows.length], screen: [full.screen.length, planned.screen.length], kept: planned.rows.includes(scene.prompt) }),
      KEPT_HINT,
    )
  }

  section('§10 a snapshot left by the build before this one (schema 8), holding only what its prune kept, is not served')
  {
    process.env.MERCURY_RESUME_SNAPSHOT = '1'
    const scene = await writeLeafScene('large')
    const late = scene.reports[0]!
    await read(scene.file, false)
    const sidecar = snapshotPathFor(scene.file)
    const written = JSON.parse(readFileSync(sidecar, 'utf8')) as { schemaVersion: number; fold: { messages: { '«map»': Array<[string, unknown]> } }; order: string[] }
    writeFileSync(sidecar, JSON.stringify({ ...written, schemaVersion: 8, fold: { ...written.fold, messages: { '«map»': written.fold.messages['«map»'].filter(([id]) => id === late) } }, order: written.order.filter(id => id === late) }))
    const snapshotHint = 'SNAPSHOT_SCHEMA in src/sessions/transcripts/resumeSnapshot.ts must move past 8 in the commit that changes what the prune keeps'
    check('stale snapshot: a schema-8 snapshot is refused', SNAPSHOT_SCHEMA > 8 && (await tryLoadResumeSnapshot(scene.file, true)) === null, `SNAPSHOT_SCHEMA=${SNAPSHOT_SCHEMA}`, snapshotHint)
    const rebuilt = endsOf(await read(scene.file, false))
    const renewed = JSON.parse(readFileSync(sidecar, 'utf8')) as { schemaVersion: number }
    check('stale snapshot: the file is read again whole, ends on the reply behind its summary, and a snapshot of this build stands in its place', rebuilt.primary === scene.final && rebuilt.rows.includes(scene.summary!) && renewed.schemaVersion === SNAPSHOT_SCHEMA && SNAPSHOT_SCHEMA > 8, j({ end: rebuilt.primary === scene.final, rows: rebuilt.rows.length, schema: renewed.schemaVersion }), snapshotHint)
    const served = endsOf(await read(scene.file, false))
    check('stale snapshot: the renewed snapshot serves the same end and rows', j(served) === j(rebuilt), j({ served: served.rows.length, rebuilt: rebuilt.rows.length }), snapshotHint)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ A BIG FILE IS PRUNED AROUND THE ELECTED END (${checks} checks)` : ` ❌ ${failures} of ${checks} BIG-FILE PRUNE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

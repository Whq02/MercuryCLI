#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runArtifactArena, requireDist, type ArenaRun } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'superseded-partial-home-'))
process.env.MERCURY_DAEMON_DIR = join(process.env.MERCURY_CONFIG_DIR, 'daemon')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 6000)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)
const source = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

const SETTLED_THINKING = 'Considering what happened before the connection was cut.'
const PARTIAL = ['What just happened: the first stream ', 'carried these words ', 'off the top of my head and']
const PARTIAL_TAIL = 'off the top of my head and'
const FINAL = 'The whole reply, sent again on a fresh connection.'

section('§1 the seat: a retracted stream publishes the withdrawn id with its clear, and keeps it until new text')
try {
  const { onSeatRow } = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
  const dir = mkdtempSync(join(tmpdir(), 'superseded-partial-daemon-'))
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-superseded01'
  const SHORT = 'concourse-sp1'
  updateConcourseWorkers(workers => {
    workers[SHORT] = {
      schema: 1, runnerId: SHORT, sessionId: sid, workspaceId: 'ws-sp', isolation: 'exclusive', modelKey: 'claude-opus-5', effort: 'high',
      spawnedAt: Date.now(), lastLiveAt: Date.now(), workspaceKind: 'plain-folder',
      settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    } as never
  }, dir)
  const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
  const tail = () => readSessionTail(sid, dir) as (Record<string, unknown> & { text?: string | null; messageId?: string; withdrawn?: string }) | null
  const published = async (want: (t: ReturnType<typeof tail>) => boolean): Promise<void> => {
    const ceiling = Date.now() + 5_000
    while (!want(tail()) && Date.now() < ceiling) await new Promise<void>(resolve => setImmediate(resolve))
  }
  let seq = 0
  const feed = (o: Record<string, unknown>): void => onSeatRow(SHORT, { seq: ++seq, timestamp: 't', session_id: sid, turn: 1, ...o } as never, roster as never, dir)
  const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }

  feed({ type: 'block_start', message_id: 'msg_first', block: 1, of: 'text' })
  feed({ type: 'text_delta', message_id: 'msg_first', block: 1, text: PARTIAL[0] })
  feed({ type: 'text_delta', message_id: 'msg_first', block: 1, text: PARTIAL[2] })
  await published(t => t?.text === PARTIAL[0] + PARTIAL[2])
  check('the first stream\'s text is the tail under its id', tail()?.text === PARTIAL[0] + PARTIAL[2] && tail()?.messageId === 'msg_first' && tail()?.withdrawn === undefined, j(tail()))
  feed({ type: 'retracted', message_id: 'msg_first' })
  check('the retraction clears the tail, drops the id and names the withdrawn message', tail()?.text === null && tail()?.messageId === undefined && tail()?.withdrawn === 'msg_first', j(tail()))
  feed({ type: 'block_start', message_id: 'msg_second', block: 0, of: 'reasoning' })
  check('the next message\'s block start keeps the withdrawn id standing (a coalesced read still learns it)', tail()?.text === null && tail()?.messageId === 'msg_second' && tail()?.withdrawn === 'msg_first', j(tail()))
  feed({ type: 'block_start', message_id: 'msg_second', block: 1, of: 'text' })
  feed({ type: 'text_delta', message_id: 'msg_second', block: 1, text: FINAL })
  await published(t => t?.text === FINAL)
  check('the reissued stream\'s first text retires the withdrawn id', tail()?.text === FINAL && tail()?.messageId === 'msg_second' && tail()?.withdrawn === undefined, j(tail()))
  feed({ type: 'text', message_id: 'msg_second', block: 1, text: FINAL })
  feed({ type: 'outcome', schema: 1, turn_id: 't-sp', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
  check('control: the settled reply clears the tail under its own id and the outcome zeroes it, with no withdrawn mark', tail()?.text === null && tail()?.messageId === undefined && tail()?.withdrawn === undefined, j(tail()))
  feed({ type: 'block_start', message_id: 'msg_third', block: 0, of: 'text' })
  feed({ type: 'text_delta', message_id: 'msg_third', block: 0, text: 'half a reply' })
  feed({ type: 'retracted', message_id: 'msg_third' })
  feed({ type: 'outcome', schema: 1, turn_id: 't-sp2', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
  check('refusal: the turn\'s outcome retires a withdrawn mark the next text never consumed', tail()?.withdrawn === undefined && tail()?.text === null, j(tail()))
  rmSync(dir, { recursive: true, force: true })
} catch (error) {
  check('the seat leg ran', false, String(error))
}

section('§2 the one paint filter: a reply the record marks retracted is never painted; an unmarked list keeps its identity')
try {
  const { withoutRetractedReplies } = await import('../../src/services/engine-connector/midTurnText.ts')
  const assistant = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'assistant', uuid: `u-${id}`, timestamp: 't', message: { id, role: 'assistant', content: [{ type: 'text', text }] }, ...extra }) as never
  const user = { type: 'user', uuid: 'u-user', timestamp: 't', message: { role: 'user', content: 'hello' } } as never
  const notice = { type: 'system', subtype: 'stream_cut', uuid: 'u-notice', timestamp: 't', content: 'cut' } as never
  const rows = [user, assistant('msg_first', PARTIAL.join(''), { retracted: true }), notice, assistant('msg_second', FINAL)]
  const painted = withoutRetractedReplies(rows) as Array<{ type: string; message?: { id?: string } }>
  check('the retracted reply is dropped; the user row, the notice and the final reply stay in order', painted.map(row => row.type === 'assistant' ? row.message?.id : row.type).join(',') === 'user,system,msg_second', j(painted.map(row => row.type)))
  const plain = [user, assistant('msg_second', FINAL)]
  check('control: a list with no retracted reply comes back as the same array (no repaint churn)', withoutRetractedReplies(plain) === plain)
  const userRetracted = [{ ...(user as object), retracted: true } as never, assistant('msg_second', FINAL)]
  check('refusal: the mark is read on assistant rows alone — a stray mark on a user row drops nothing', withoutRetractedReplies(userRetracted).length === 2)
  check('the connector paints through the filter beside the operator-rewind projection', /withoutRetractedReplies\(projectOperatorRewinds\(this\.rawRecords\)\)/.test(source('src/services/engine-connector/daemonConnector.ts')))
  check('the rows writer re-settles the withdrawn record with the mark (the chain stays whole: no row is removed)', /settleTranscriptMessage\(\{ \.\.\.\(event\.message as AssistantMessage\), retracted: true \}\)/.test(source('src/rows/turn.ts')) && !/removeTranscriptMessage/.test(source('src/rows/turn.ts')))
} catch (error) {
  check('the paint-filter leg ran', false, String(error))
}

section('§3 the screen, end to end: the provider cuts the first stream after content, the reissue answers whole — one reply on the screen, the final; the record names the partial; a reload paints one reply')
requireDist()
function finalScreen(run: ArenaRun, cols: number, rows: number): string {
  const res = spawnSync('/usr/bin/python3', [join(HERE, 'screengrab.py'), run.paths.drive, String(cols), String(rows), '-1'], { encoding: 'utf8', timeout: 60_000 })
  return (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!.rows.join('\n')
}
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1
const run = await runArtifactArena({
  turns: [
    { kind: 'die', settled: [{ thinking: SETTLED_THINKING }], deltas: PARTIAL, gapMs: 400, whenModel: 'opus' },
    { kind: 'text', text: FINAL, whenModel: 'opus' },
  ],
  sends: ['4500:tell me what happened', '5300:\\r'],
  seconds: 28,
  keep: true,
})
try {
  const screen = finalScreen(run, 120, 40)
  check('the final reply is on the screen, once', count(screen, 'The whole reply') === 1, screen)
  check('the cut stream\'s partial is not painted anywhere on the final screen (the ghost the owner saw)', !screen.includes(PARTIAL_TAIL) && !screen.includes('What just happened'), screen)
  check('the composer is back (the turn settled)', /type a prompt|↵ sends|\? for shortcuts/.test(screen), screen)
  const projects = join(run.paths.home, '.mercury', 'projects')
  const transcripts = existsSync(projects)
    ? readdirSync(projects, { withFileTypes: true }).flatMap(store => store.isDirectory() ? readdirSync(join(projects, store.name)).filter(name => /^[0-9a-f-]{36}\.jsonl$/.test(name)).map(name => join(projects, store.name, name)) : [])
    : []
  check('one session transcript was written', transcripts.length === 1, j(transcripts))
  const transcript = transcripts[0]
  if (transcript !== undefined) {
    type Stored = { recordId?: string; updates?: string; annotations?: { retracted?: unknown }; payload?: { kind?: string; content?: Array<{ kind?: string; text?: string }>; outcome?: { result?: string } } }
    const lines = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Stored)
    const byId = new Map<string, Stored>()
    for (const record of lines) if (record.recordId !== undefined) byId.set(record.recordId, record)
    const outputs = [...byId.values()].filter(record => record.payload?.kind === 'output')
    const textOf = (record: Stored): string => (record.payload?.content ?? []).filter(block => block.kind === 'text').map(block => block.text ?? '').join('')
    const kindsOf = (record: Stored): string[] => (record.payload?.content ?? []).map(block => block.kind ?? '')
    const settledRows = outputs.filter(record => kindsOf(record).includes('reasoning') && !kindsOf(record).includes('text'))
    check('the cut stream\'s settled thinking block is on disk (the one row the record keeps of the withdrawn reply, as in the owner\'s record)', settledRows.length === 1, j(outputs.map(kindsOf)))
    check('…and that row is re-settled with the retracted mark, as an update of the same record (never a second row)', settledRows.every(record => record.annotations?.retracted === true && typeof record.updates === 'string'), j(settledRows.map(record => [record.recordId, record.updates, record.annotations])))
    check('the partial that never settled is on no row at all', outputs.every(record => !textOf(record).includes('What just happened')), j(outputs.map(textOf)))
    const finalRows = outputs.filter(record => textOf(record).includes('The whole reply'))
    check('the final reply is recorded once, unmarked', finalRows.length === 1 && finalRows[0]?.annotations?.retracted !== true, j(finalRows.map(record => [record.recordId, record.annotations])))
    const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
    const midTurn = await import('../../src/services/engine-connector/midTurnText.ts')
    const withoutRetractedReplies: (rows: never) => unknown[] = midTurn.withoutRetractedReplies ?? ((rows: never) => rows as unknown as unknown[])
    const loaded = await loadTranscriptFile(transcript)
    const conversation = [...loaded.messages.values()] as Array<{ type: string; subtype?: string; retracted?: unknown; message?: { content?: Array<{ type?: string; text?: string }> } }>
    const replies = withoutRetractedReplies(conversation as never) as typeof conversation
    const texts = replies.filter(row => row.type === 'assistant').flatMap(row => (row.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
    check('a reload paints one reply, the final (the loader keeps the chain; the paint filter drops the marked row)', texts.length === 1 && texts[0]!.includes('The whole reply'), j(texts))
    check('…the loaded conversation still carries the marked row (the chain stays whole) beside the user turn, the cut notice and the reply', conversation.some(row => row.type === 'assistant' && row.retracted === true) && conversation.some(row => row.type === 'user') && conversation.some(row => row.type === 'system' && row.subtype === 'stream_cut'), j(conversation.map(row => [row.type, row.subtype ?? '', row.retracted === true ? 'retracted' : ''])))
  }
} finally {
  run.cleanup()
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

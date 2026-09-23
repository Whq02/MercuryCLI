#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = mkdtempSync(join(tmpdir(), 'restart-carry-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HOME, 'teams')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const lr = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const q = await import('../../src/input-core/command-queue.ts')
const { recordTranscript } = await import('../../src/utils/sessionStorage.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { AGENT_RESUME_NOTE, agentStopReasonOf, AGENT_STOP_BY_OPERATOR } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.ts')

console.log('============================================================')
console.log(' the restart carry — the words, the queue log, the journal identity, the seat facts')
console.log(" red on the base: every check in C1-C5 (the helpers do not exist there), J1-J2 (the journal carries no identity), S1-S2 (the generation restarts at 0, no queueReady)")
console.log('============================================================')

section('C1 the ruled row: one row, the crash words and the cut words')
{
  const crash = lr.restartCarryRow('crash', { relaunched: 2, delivered: 1, stopped: 0 })
  check('a crash restart names the crash in the ruled shape', crash === 'runner restarted after a crash: 2 background agents relaunched, 1 delivered from their receipts, 0 stopped', crash)
  const stop = lr.restartCarryRow('stop', { relaunched: 3, delivered: 0, stopped: 0 })
  check("a stop restart says the cut, never a crash: 'after the turn was cut'", stop === 'runner restarted after the turn was cut: 3 background agents relaunched, 0 delivered from their receipts, 0 stopped' && !stop.includes('crash'), stop)
  check('the row is recognisable by its prefix (the wake reads it)', lr.isRestartCarryRow(crash) && lr.isRestartCarryRow(stop) && !lr.isRestartCarryRow('<task-notification>'))
  check('the relaunch note is shaped like the resume note and tells the agent to read its diff before it edits', lr.AGENT_RELAUNCH_NOTE.includes('Continue from where your transcript ends') && AGENT_RESUME_NOTE.includes('Continue from where your transcript ends') && /git diff/.test(lr.AGENT_RELAUNCH_NOTE) && /read a file again before you edit it/.test(lr.AGENT_RELAUNCH_NOTE), lr.AGENT_RELAUNCH_NOTE)
}

section('C2 the queue log: enqueue rows in both record shapes, with the identity fields when the runner wrote them')
const envelope = (fields: Record<string, unknown>): string =>
  j({ schemaVersion: 1, recordId: 'r', sessionId: 's', threadId: 'main', occurredAt: '2026-01-01T00:00:00.000Z', actor: { role: 'system' }, payload: { kind: 'session-meta', metaKind: 'queue-operation', fields: { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', ...fields } } })
const raw = (fields: Record<string, unknown>): string => j({ type: 'queue-operation', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 's', ...fields })
{
  const rows = lr.queueLogRows([
    envelope({ operation: 'enqueue', content: 'the operator words', uuid: 'u-1', mode: 'prompt', sentAt: '2026-01-01T00:00:00.500Z' }),
    raw({ operation: 'dequeue' }),
    'not json at all',
    envelope({ operation: 'enqueue', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>', mode: 'task-notification' }),
    j({ payload: { kind: 'input' } }),
  ])
  check('both shapes parse, torn and foreign lines are skipped', rows.length === 3 && rows[0]!.operation === 'enqueue' && rows[1]!.operation === 'dequeue' && rows[2]!.mode === 'task-notification', j(rows))
  check('the identity fields ride the row: uuid, mode, sentAt and the enqueue clock', rows[0]!.uuid === 'u-1' && rows[0]!.mode === 'prompt' && rows[0]!.sentAt === '2026-01-01T00:00:00.500Z' && rows[0]!.at === '2026-01-01T00:00:00.000Z', j(rows[0]))
}

section('C3 the undelivered lines: what the dying runner still held, by the log alone')
{
  const rows = lr.queueLogRows([
    envelope({ operation: 'enqueue', content: 'first words, taken', uuid: 'u-a', mode: 'prompt' }),
    envelope({ operation: 'dequeue' }),
    envelope({ operation: 'enqueue', content: 'a nudge the runner wrote to itself', uuid: 'u-n', mode: 'prompt', isMeta: true }),
    envelope({ operation: 'enqueue', content: 'the line typed during the turn', uuid: 'u-b', mode: 'prompt', sentAt: '2026-01-01T00:10:14.655Z' }),
    envelope({ operation: 'enqueue', content: '<task-notification>\n<task-id>a2</task-id>\n<status>killed</status>\n</task-notification>', mode: 'task-notification' }),
    envelope({ operation: 'enqueue', content: 'ls -la', uuid: 'u-c', mode: 'bash' }),
  ])
  const pending = lr.pendingQueueLogRows(rows)
  check('the replay leaves what no dequeue took: the nudge, the line, the notice, the bash line', pending.map(r => r.uuid ?? r.mode).join(',') === 'u-n,u-b,task-notification,u-c', j(pending.map(r => r.uuid ?? r.mode)))
  const lines = lr.undeliveredLines(rows)
  check("the operator's lines are the prompt and bash rows that are not meta and not notices, oldest first", lines.map(r => r.uuid).join(',') === 'u-b,u-c' && lines[0]!.sentAt === '2026-01-01T00:10:14.655Z', j(lines))
  const byIdentity = lr.pendingQueueLogRows(lr.queueLogRows([
    envelope({ operation: 'enqueue', content: 'one', uuid: 'u-1', mode: 'prompt' }),
    envelope({ operation: 'enqueue', content: 'two', uuid: 'u-2', mode: 'prompt' }),
    envelope({ operation: 'pop', content: 'two', uuid: 'u-2', mode: 'prompt' }),
  ]))
  check('a taking row that names an identity takes that line, not the oldest', byIdentity.length === 1 && byIdentity[0]!.uuid === 'u-1', j(byIdentity))
  const legacy = lr.undeliveredLines(lr.queueLogRows([envelope({ operation: 'enqueue', content: 'an old row with no mode' })]))
  check('a row an older runner wrote (no mode) is never re-queued — the words alone cannot say what it was', legacy.length === 0)
  const emptied = lr.pendingQueueLogRows(lr.queueLogRows([envelope({ operation: 'enqueue', content: 'x', mode: 'prompt' }), envelope({ operation: 'popAll' })]))
  check('popAll empties the pending set', emptied.length === 0)
}

section('C4 the held notices: the finished agent, the operator stop, the runner-death stop')
{
  const crewViewStop = `Agent "beta" was ${agentStopReasonOf(AGENT_STOP_BY_OPERATOR)} — its work is kept`
  const notice = (id: string, status: string, summary: string): string =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`
  const held = lr.heldAgentNotices(
    [
      envelope({ operation: 'enqueue', content: notice('alpha', 'completed', 'Agent "alpha" completed'), mode: 'task-notification', sentAt: '2026-01-01T00:05:00.000Z' }),
      envelope({ operation: 'enqueue', content: notice('beta', 'killed', crewViewStop), mode: 'task-notification' }),
      envelope({ operation: 'enqueue', content: notice('gamma', 'killed', 'Agent "gamma" was stopped — 7 file writes landed: /w/a.ts, /w/b.ts — its work is kept; resume it from the crew view'), mode: 'task-notification' }),
      envelope({ operation: 'enqueue', content: notice('delta', 'failed', 'Agent "delta" failed: boom'), mode: 'task-notification' }),
      envelope({ operation: 'enqueue', content: notice('delta', 'killed', 'Agent "delta" was stopped'), mode: 'task-notification' }),
      envelope({ operation: 'enqueue', content: notice('other', 'completed', 'not asked for'), mode: 'task-notification' }),
    ],
    new Set(['alpha', 'beta', 'gamma', 'delta']),
  )
  check('only the asked ids come back, one notice each', [...held.keys()].sort().join(',') === 'alpha,beta,delta,gamma', j([...held.keys()]))
  check('a completed notice is a finished agent, with its completion clock', held.get('alpha')?.status === 'completed' && held.get('alpha')?.at === '2026-01-01T00:05:00.000Z' && held.get('alpha')?.operatorStop === false)
  check("the crew view's stop is the operator's own act", held.get('beta')?.status === 'killed' && held.get('beta')?.operatorStop === true)
  check("the runner-death stop is not the operator's, and its landed writes are read", held.get('gamma')?.operatorStop === false && held.get('gamma')?.landedWrites === '7 file writes landed: /w/a.ts, /w/b.ts', j(held.get('gamma')))
  check('an outcome outranks a later stop for the same agent', held.get('delta')?.status === 'failed')
  const record = lr.settledRecordFor({ toolUseId: 'toolu_alpha', agentId: 'alpha', description: 'alpha', prompt: 'p', agentType: 'mercury-general', launchedAt: 1 }, 'completed', 7)
  check('the settled record carries the held status, is notified, and names no restart error', record.status === 'completed' && record.notified === true && record.error === undefined && record.toolUseId === 'toolu_alpha', j(record))
}

section('C5 the ids a queued_command attachment already carried')
{
  const attachment = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>toolu_a9</tool-use-id>\n<status>completed</status>\n</task-notification>' } } as never
  const resumed = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a8</task-id>\n<status>resumed</status>\n</task-notification>' } } as never
  const ids = lr.queuedNoticeIds([attachment, resumed])
  check('a delivered notice names its task id and tool-use id; a resumed receipt names nothing', ids.has('a9') && ids.has('toolu_a9') && !ids.has('a8'), j([...ids]))
}

section("J1 the journal carries the line's identity: uuid, mode and the send clock ride the enqueue row")
{
  q.resetCommandQueue()
  const lineUuid = '00000000-0000-4000-8000-000000000031'
  q.enqueue({ value: 'the words the journal keeps', mode: 'prompt', uuid: lineUuid, sentAt: '2026-01-01T00:10:14.655Z' } as never)
  q.enqueuePendingNotification({ value: '<task-notification>\n<task-id>j1</task-id>\n<status>completed</status>\n</task-notification>', mode: 'task-notification', priority: 'next' } as never)
  q.enqueue({ value: 'a nudge', mode: 'prompt', isMeta: true, priority: 'later' } as never)
  await recordTranscript([createUserMessage({ content: 'a real message materializes the file' })])
  const rows: Array<Record<string, unknown>> = []
  const deadline = Date.now() + 3000
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) {
        for (const row of lr.queueLogRows(readFileSync(p, 'utf8').split('\n'))) rows.push(row as unknown as Record<string, unknown>)
      }
    }
  }
  while (Date.now() < deadline) {
    rows.length = 0
    try {
      walk(join(HOME, 'projects'))
    } catch {
    }
    if (rows.filter(r => r.operation === 'enqueue').length >= 3) break
    await sleep(100)
  }
  const enqueues = rows.filter(r => r.operation === 'enqueue')
  const words = enqueues.find(r => r.content === 'the words the journal keeps')
  const notice = enqueues.find(r => typeof r.content === 'string' && (r.content as string).includes('<task-id>j1</task-id>'))
  const nudge = enqueues.find(r => r.content === 'a nudge')
  check('J1 the operator line rides with its uuid, its mode and the send clock (red on the base: content only)', words !== undefined && words.uuid === lineUuid && words.mode === 'prompt' && words.sentAt === '2026-01-01T00:10:14.655Z', j(words))
  check('J1 a notification carries its mode and its enqueue clock as sentAt (the completion, for the row stamp)', notice !== undefined && notice.mode === 'task-notification' && typeof notice.sentAt === 'string' && Number.isFinite(Date.parse(notice.sentAt as string)), j(notice))
  check('J1 a meta line says so, and is never an operator line', nudge !== undefined && nudge.isMeta === true && lr.undeliveredLines(rows as never).every(r => r.content !== 'a nudge'), j(nudge))
  check('J1 the runner-side replay of this very journal names the one undelivered operator line', lr.undeliveredLines(rows as never).map(r => r.uuid).join(',') === lineUuid, j(lr.undeliveredLines(rows as never)))
}

section('J2 a notification drained into an attachment keeps its completion clock in sentAt and takes the delivery clock as its row time')
{
  const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
  const before = Date.now()
  const noticeRow = createAttachmentMessage({ type: 'queued_command', prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification', sentAt: '2026-01-01T00:05:00.000Z' } as never)
  const wordsRow = createAttachmentMessage({ type: 'queued_command', prompt: 'typed words', commandMode: 'prompt', sentAt: '2026-01-01T00:05:00.000Z' } as never)
  check('J2 the notice row is stamped at delivery (now), its sentAt untouched (red on the base: the row took the enqueue clock)', Date.parse(noticeRow.timestamp) >= before && (noticeRow.attachment as { sentAt?: string }).sentAt === '2026-01-01T00:05:00.000Z', noticeRow.timestamp)
  check("J2 the operator's words keep their send clock as the row time (byte-identical)", wordsRow.timestamp === '2026-01-01T00:05:00.000Z', wordsRow.timestamp)
}

section('S1-S2 the seat facts: a fresh incarnation across a seat delete and re-create, and queueReady')
{
  const { onSeatSpawned, onSeatSettled, publishSeatFacts, seatGenerationOf, queueReadinessFacts } = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const dir = mkdtempSync(join(tmpdir(), 'restart-carry-daemon-'))
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-restartcarry'
  const SHORT = 'concourse-rc1'
  updateConcourseWorkers(workers => {
    workers[SHORT] = {
      schema: 1,
      runnerId: SHORT,
      sessionId: sid,
      workspaceId: 'ws-rc',
      isolation: 'exclusive',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
      workspaceKind: 'plain-folder',
    } as never
  }, dir)
  const roster = { control: () => true, list: () => [], patchSeatModel: () => true }
  onSeatSpawned(SHORT, roster as never, dir)
  const first = seatGenerationOf(SHORT)
  publishSeatFacts(SHORT, dir, roster as never)
  const skeleton = readSessionFacts(sid, dir) as (Record<string, unknown> & { runnerGeneration?: number; queueReady?: boolean }) | null
  check('S1 the first life is generation 1 and its skeleton facts say the queue is not ready yet (red on the base: no queueReady)', first === 1 && skeleton?.runnerGeneration === 1 && skeleton?.queueReady === false, j(skeleton))
  onSeatSettled(SHORT)
  onSeatSpawned(SHORT, roster as never, dir)
  const second = seatGenerationOf(SHORT)
  publishSeatFacts(SHORT, dir, roster as never)
  const revived = readSessionFacts(sid, dir) as { runnerGeneration?: number } | null
  check('S2 a seat deleted at settle and re-created at the revive is generation 2, never 1 again (red on the base: 1→1, the screen never sees a move)', second === 2 && revived?.runnerGeneration === 2, `generation ${second} · facts ${j(revived?.runnerGeneration)}`)
  check('S2 queueReady turns on the runner\'s first real answer, not before', queueReadinessFacts({ lastAnswer: null }).queueReady === false && queueReadinessFacts({ lastAnswer: {} as never }).queueReady === true)
  rmSync(dir, { recursive: true, force: true })
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL RESTART-CARRY PROOFS PASS')
else console.log(`❌ ${failures} RESTART-CARRY PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

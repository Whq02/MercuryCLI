import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { boardNamesSeat, boardWaitWords, boardWakeEligible, matchesBoardWait, parseBoardWait, type BoardWait } from '../../src/services/crewBoard/waits.ts'
import type { BoardEvent, BoardSeat } from '../../src/services/crewBoard/contracts.ts'

let checks = 0
const check = (label: string, value: unknown): void => { assert(value, label); checks++; console.log(`PASS ${label}`) }
const reader: BoardSeat = { agent: 'reader', name: 'Reader', team: 'engine' }
const writer: BoardSeat = { agent: 'writer', name: 'Writer One', team: 'engine' }
const other: BoardSeat = { agent: 'other', name: 'Other', team: 'view' }
const seats = [reader, writer, other]
const declaration = (text: string) => parseBoardWait({ kind: 'ask', text }, reader, seats)
const arm = (text: string): BoardWait => {
  const predicate = declaration(text)
  assert(predicate)
  return { eventId: 'declared', seq: 10, version: 1, predicate, standing: false }
}
const event = (extra: Partial<BoardEvent> & { addresses?: string[]; authorRole?: 'peer' | 'owner' | 'system'; channel?: { kind: string }; recipients?: BoardSeat[] } = {}) => ({
  schema: 1 as const, boardId: 'board', waveId: 'wave', eventId: 'posted', clientOpId: 'post', seq: 11,
  author: { sessionId: 'session', agentId: writer.agent, executionId: 'run' }, authorName: writer.name,
  kind: 'result' as const, text: 'The parser passed.', team: 'engine', addresses: [], mentions: [], relatedTasks: [], files: [], refs: [],
  createdAt: '2026-01-01T00:00:00.000Z', payloadDigest: '0'.repeat(64), threadId: 'thread', policyRevision: 1 as const, ...extra,
})
const bySeat = arm('@main wake me when seat "Writer One" posts')
const bySubject = arm('@main wake me when about parser.ts')
const byKind = arm('@main wake me when kind result')
const byTraffic = arm('@main wake me when team @ENGINE posts')
check('the four declarations bind a typed predicate and canonical words', bySeat.predicate.kind === 'seat' && bySeat.predicate.agent === writer.agent && boardWaitWords(bySeat.predicate) === 'seat "Writer One" posts' && boardWaitWords(bySubject.predicate) === 'about parser.ts' && boardWaitWords(byKind.predicate) === 'kind result' && boardWaitWords(byTraffic.predicate) === 'team engine posts')
check('seat ids and quoted single names resolve through the same exact roster', declaration('@main wake me when seat writer posts')?.kind === 'seat' && declaration("@main wake me when seat 'writer one' posts")?.kind === 'seat')
for (const text of ['@main wake me when seat Missing posts', '@main wake me when seat Writer One posts', '@main wake me when seat writer posts later', '@main wake me when team view posts', '@main wake me when kind notice', '@main wake me when about ', '@main wake me when anything happens', '@main wake me when kind result\nthen run it']) {
  assert.throws(() => declaration(text))
}
assert.throws(() => parseBoardWait({ kind: 'result', text: '@main wake me when kind result' }, reader, seats))
assert.throws(() => parseBoardWait({ kind: 'ask', text: '@main wake me when seat Duplicate posts' }, reader, [...seats, { agent: 'a', name: 'Duplicate' }, { agent: 'b', name: 'duplicate' }]))
check('malformed declarations and ambiguous names are refused; prose is inert', declaration('I will ask @main wake me when something happens later.') === null)
check('only posts after the declaration match, and seat waits bind the stable id', matchesBoardWait(event({ authorName: 'Renamed' }), bySeat, reader.agent) && !matchesBoardWait(event({ seq: 10 }), bySeat, reader.agent) && !matchesBoardWait(event({ author: { sessionId: 'session', agentId: 'new-writer', executionId: 'run' } }), bySeat, reader.agent))
check('about matches subject text or a normalised exact file, never incidental body text', matchesBoardWait(event({ about: 'The PARSER.TS fix' }), bySubject, reader.agent) && matchesBoardWait(event({ files: ['./parser.ts'] }), bySubject, reader.agent) && !matchesBoardWait(event({ text: 'parser.ts fixed', files: ['src/parser.ts'] }), bySubject, reader.agent))
check('kind and own-team traffic predicates use committed routing', matchesBoardWait(event(), byKind, reader.agent) && !matchesBoardWait(event({ kind: 'blocker' }), byKind, reader.agent) && matchesBoardWait(event({ team: 'view', recipients: [reader] }), byTraffic, reader.agent) && !matchesBoardWait(event({ team: 'view', mentions: ['reader'] }), byTraffic, reader.agent))
check('a stable named recipient wakes without a declaration; a team expansion is not a named seat', boardNamesSeat(event({ addresses: ['Reader'], recipients: [reader] }), reader) && !boardNamesSeat(event({ mentions: ['reader'], addresses: ['engine'] }), reader))
check('self, main, lifecycle, mirrors and broadcasts cannot wake a peer', !boardWakeEligible(event(), writer.agent) && !boardWakeEligible(event(), 'main') && !boardWakeEligible(event({ authorRole: 'system' }), reader.agent) && !boardWakeEligible(event({ kind: 'notice' }), reader.agent) && !boardWakeEligible(event({ kind: 'message' }), reader.agent) && !boardNamesSeat(event({ addresses: ['all', 'Reader'], recipients: [reader] }), reader) && !matchesBoardWait(event({ addresses: ['all'] }), byKind, reader.agent))
check('direct owner posts can wake, general cannot, and body mentions never route', boardNamesSeat(event({ authorRole: 'owner', mentions: ['reader', 'main'], channel: { kind: 'whisper', target: 'Reader' }, text: '@all is only body text' }), reader) && !boardNamesSeat(event({ authorRole: 'owner', mentions: ['reader', 'main'], channel: { kind: 'general' } }), reader))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { boardResumeRefusal } = await import('../../src/tools/AgentTool/resumeAgent.ts')
const { operatorPauseGate } = await import('../../src/run-core/pauseGate.ts')
const task = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'local_agent', id: 'reader', agentId: 'reader', status, ...extra })
check('a completed local task can resume but a live owner cannot', boardResumeRefusal('reader', { reader: task('completed') }) === null && boardResumeRefusal('reader', { reader: task('running') }) !== null)
for (const held of [task('pending'), task('killed'), task('failed', { stopReason: 'crew-stop' }), task('failed', { paused: { why: 'provider busy' } })]) assert.notEqual(boardResumeRefusal('reader', { reader: held }), null)
check('pending, stopped and provider-paused tasks retain their guard', true)
operatorPauseGate.pause()
try {
  check('a board event never lifts the operator pause', boardResumeRefusal('reader', { reader: task('completed') }) !== null && operatorPauseGate.holds('reader'))
} finally { operatorPauseGate.resume() }
const { Database } = await import('bun:sqlite')
const { createWakeState } = await import('../../src/services/crewBoard/wakeState.ts')
const db = new Database(':memory:')
db.exec('CREATE TABLE seen_events (agent TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(agent, event))')
const wakes = createWakeState(db, false)
const transaction = <T,>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error } }
try {
  wakes.enroll(reader.agent, 'first')
  wakes.declare(reader.agent, event({ eventId: 'wait', seq: 10 }), byKind.predicate)
  const beforePark = event({ eventId: 'before-park', seq: 12 })
  assert.deepEqual(wakes.posted(beforePark, seats), [reader.agent])
  check('a declared matching post received while running cannot start a second execution', wakes.state(reader.agent) === 'running' && wakes.pending().length === 0)
  wakes.presented(reader.agent, [beforePark.eventId])
  check('presenting the match while running consumes the arm', wakes.wait(reader.agent) === undefined)
  wakes.declare(reader.agent, event({ eventId: 'wait-two', seq: 13 }), byKind.predicate)
  const unread = event({ eventId: 'unread', seq: 14 })
  wakes.posted(unread, seats)
  wakes.settle(reader.agent, 'first', 14)
  check('early runAgent settlement cannot dispatch before the completion notice', wakes.state(reader.agent) === 'parked' && wakes.pending().length === 0)
  wakes.complete(reader, 'first', 14, 'completed')
  check('an unread matching post carries across parking', wakes.pending()[0]?.eventId === unread.eventId)
  const candidate = wakes.pending()[0]!
  const claimed = transaction(() => wakes.claim(candidate))!
  assert(claimed)
  check('one atomic claim reserves the event without displaying a running seat', wakes.state(reader.agent) === 'parked' && transaction(() => wakes.claim(candidate)) === null && wakes.pending().length === 0)
  wakes.hold(claimed, 'admission refused')
  check('a failed admission stays unread and held without spin retry', wakes.pending().length === 0 && wakes.wait(reader.agent) !== undefined && db.query('SELECT state FROM wake_claims WHERE agent = ?').get(reader.agent)?.state === 'held')
  wakes.enroll(reader.agent, 'second')
  wakes.presented(reader.agent, [unread.eventId])
  check('the lead can resume a held seat, carrying the same unread event', wakes.state(reader.agent) === 'running' && wakes.wait(reader.agent) === undefined)
  wakes.complete(reader, 'second', 15, 'completed')
  const named = event({ eventId: 'named', seq: 16, addresses: ['Reader'], recipients: [reader] })
  wakes.posted(named, seats)
  check('a named post can wake a parked seat without a wait', wakes.pending()[0]?.eventId === named.eventId)
  const namedClaim = transaction(() => wakes.claim(wakes.pending()[0]!))!
  wakes.enroll(reader.agent, 'third')
  wakes.admitted(namedClaim)
  wakes.admitted(namedClaim)
  check('an accepted wake is counted once and does not mark its packet presented', wakes.turns() === 1 && db.query('SELECT COUNT(*) AS n FROM seen_events').get()?.n === 0)
  wakes.presented(reader.agent, [named.eventId])
  wakes.complete(reader, 'third', 17, 'stopped')
  wakes.posted(event({ eventId: 'stopped-name', seq: 18, addresses: ['Reader'], recipients: [reader] }), seats)
  check('a settled operator stop remains held after local task eviction', namedClaim !== null && wakes.pending().length === 0)
  wakes.enroll(writer.agent, 'captain-one')
  const captain = { ...writer, captain: true as const }
  wakes.captains([reader, captain, other], 20)
  assert.equal(wakes.wait(writer.agent)?.standing, true)
  wakes.complete(captain, 'captain-one', 21, 'completed')
  const traffic = event({ eventId: 'captain-traffic', seq: 22, author: { sessionId: 'session', agentId: reader.agent, executionId: 'third' } })
  wakes.posted(traffic, [reader, captain, other])
  check('the captain has the same standing team arm and claim road', wakes.pending().some(wake => wake.agent === writer.agent && wake.eventId === traffic.eventId) && wakes.wait(writer.agent)?.seq === 21)
  wakes.captains([reader, writer, { ...other, captain: true as const }], 23)
  check('captain replacement cancels the old standing arm and creates the new one', wakes.wait(writer.agent) === undefined && wakes.wait(other.agent)?.standing === true)
  check('the lead open-waits packet can name each canonical event', wakes.open([reader, writer, other]).some(row => row.seat === 'Other' && row.event === 'team view posts'))
} finally { db.close() }
const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
const statePath = join(home, 'parked-wake.sqlite')
const first = new Database(statePath)
first.exec('PRAGMA journal_mode = WAL; CREATE TABLE seen_events (agent TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(agent, event))')
const firstState = createWakeState(first, false)
firstState.enroll(reader.agent, 'persisted')
firstState.declare(reader.agent, event({ eventId: 'persisted-wait', seq: 40 }), byKind.predicate)
firstState.complete(reader, 'persisted', 41, 'completed')
const oldArm = firstState.wait(reader.agent)!
firstState.posted(event({ eventId: 'old-match', seq: 42 }), seats)
const staleWake = firstState.pending()[0]!
firstState.declare(reader.agent, event({ eventId: 'replacement', seq: 43 }), bySubject.predicate)
check('a new declaration replaces the prior arm and refuses its stale claim', firstState.wait(reader.agent)!.version > oldArm.version && firstState.claim(staleWake) === null)
firstState.posted(event({ eventId: 'persisted-match', seq: 44, about: 'parser.ts' }), seats)
const competing = new Database(statePath)
const competingState = createWakeState(competing, false)
try {
  const a = firstState.pending()[0]!, b = competingState.pending()[0]!
  assert.deepEqual(a, b)
  first.exec('BEGIN IMMEDIATE')
  const won = firstState.claim(a)!
  first.exec('COMMIT')
  competing.exec('BEGIN IMMEDIATE')
  const lost = competingState.claim(b)
  competing.exec('COMMIT')
  check('two store handles reading the same candidate produce only one claim', won !== null && lost === null)
  firstState.hold(won, 'transcript unavailable')
} finally { first.close(); competing.close() }
const reopened = new Database(statePath, { readonly: true })
try {
  const saved = createWakeState(reopened, true)
  check('reopening preserves parked state, the replacement wait and the held claim', saved.state(reader.agent) === 'parked' && saved.wait(reader.agent)?.predicate.kind === 'about' && saved.pending().length === 0)
} finally { reopened.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(statePath + suffix, { force: true }) }
const boot = await import('../../src/bootstrap/state.ts')
boot.setOriginalCwd(home); boot.setCwdState(home); boot.setProjectRoot(home)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { getSwarmAttachments } = await import('../../src/utils/attachments/queuedCommands.ts')
assert(runSwarmCommand('on').startsWith('Swarm on'))
await seam.latchSwarmAgent('woken', 'Woken')
await seam.latchSwarmAgent('poster', 'Poster')
const board = seam.swarmStore()!
const woken = seam.swarmPrincipal('woken')!, poster = seam.swarmPrincipal('poster')!, main = seam.swarmPrincipal()!
let tasks: Record<string, unknown> = { woken: { ...task('running'), id: 'woken', agentId: 'woken' } }
const context = { getAppState: () => ({ tasks }), options: {}, abortController: new AbortController(), toolUseId: 'stale-call' } as unknown as import('../../src/Tool.ts').ToolUseContext
const leadContext = new AsyncLocalStorage<string>()
let count = 0
let finish!: () => void
const fired = new Promise<void>(resolve => { finish = resolve })
const resume: typeof import('../../src/tools/AgentTool/resumeAgent.ts').resumeAgentBackground = async args => {
  count++
  assert.equal(leadContext.getStore(), 'lead')
  assert.equal(args.toolUseContext.toolUseId, undefined)
  assert.equal(args.automatic, true)
  assert(args.boardEventIds?.length)
  assert.equal(args.prompt.split('WAKE-PACKET-WITNESS').length, 2)
  tasks = { woken: { ...task('running'), id: 'woken', agentId: 'woken' } }
  await seam.latchSwarmAgent('woken', 'Woken', false, true)
  args.onAdmitted?.()
  const attachment = createAttachmentMessage({ type: 'queued_command', prompt: args.prompt, boardEventIds: args.boardEventIds, isMeta: true, origin: { kind: 'coordinator' } })
  assert.equal(getSwarmAttachments({ ...context, agentId: 'woken' } as never, [attachment]).length, 0)
  seam.swarmPresented('woken', [attachment], 'wake-request')
  finish()
  return { agentId: args.agentId, description: 'Woken', outputFile: '' }
}
const watchers = leadContext.run('lead', () => [seam.watchSwarmResumes(() => context, (async () => ({ behavior: 'allow', updatedInput: {} })) as never, () => true, resume), seam.watchSwarmResumes(() => context, (async () => ({ behavior: 'allow', updatedInput: {} })) as never, () => true, resume)])
let timeout: ReturnType<typeof setTimeout> | undefined
try {
  assert(board.post(woken, { clientOpId: 'declare-public', kind: 'ask', text: '@main wake me when about public-trigger' }).ok)
  const beforeInvalid = board.view().snapshot
  assert.equal(board.post(woken, { clientOpId: 'declare-invalid', kind: 'ask', text: '@main wake me when arbitrary code' }).ok, false)
  check('the public post parser rejects malformed conditions before appending', board.view().snapshot === beforeInvalid)
  const posted = leadContext.run('poster', () => board.post(poster, { clientOpId: 'public-trigger', kind: 'result', text: 'WAKE-PACKET-WITNESS', about: 'public-trigger' }))
  assert(posted.ok)
  seam.settleSwarmAgent('woken')
  check('the real board requires a completed lifecycle after early settlement', board.pendingWakes().length === 0)
  const openWaits = board.boundary(main, new Set())!
  check('the main packet and roster carry the same open wait', openWaits.text.includes('"waits":[{"seat":"Woken","event":"about public-trigger"}]') && openWaits.text.includes('Woken · waiting on about public-trigger') && board.view().seats?.find(seat => seat.agent === 'woken')?.state === 'parked')
  tasks = { woken: { ...task('completed'), id: 'woken', agentId: 'woken' } }
  seam.mirrorSwarmNotice('woken', 'completion witness', 'Woken completed', 'completed')
  const parked = board.screenEvents(0).filter(event => event.author.agentId === 'woken' && event.lifecycle)
  check('the completion row says parked and not Done when its wait is armed', parked.some(event => event.lifecycle?.kind === 'parked' && event.lifecycle.event === 'about public-trigger') && !parked.some(event => event.lifecycle?.kind === 'done'))
  await Promise.race([fired, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('the board watcher never resumed its parked seat')), 5000) })])
  await new Promise<void>(resolve => setImmediate(resolve))
  check('two live watchers dispatch one packet in the lead context without a duplicate boundary copy', count === 1 && board.view().peerTurns === 1 && board.boundary(seam.swarmPrincipal('woken')!, new Set()) === null)
  const spent = board.view().admitted
  seam.swarmPresented('woken', [], 'unrelated')
  check('presentation consumes the one-shot wait and never recharges its prepared packet', board.seats().find(seat => seat.agent === 'woken')?.wait === undefined && board.view().admitted === spent)
} finally {
  if (timeout !== undefined) clearTimeout(timeout)
  for (const watcher of watchers) watcher.stop()
  runSwarmCommand('off')
  seam.settleSwarmAgent('poster'); seam.settleSwarmAgent('woken')
}
if (!process.argv.includes('--source-only')) {
  const { makeWorld, bootLead, closeWorld, LEAD_MODEL, findFiles, toolResultOf, record } = await import('./crew-world.ts')
  const childModel = 'claude-opus-4-6'
  const schema = { type: 'object', properties: { phase: { type: 'string' } }, required: ['phase'] }
  const world = await makeWorld('swarm-parked-wake', [
    { kind: 'tool_use', name: 'Bash', id: 'wake-first-pwd', input: { command: 'pwd', description: 'Read the assigned directory' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'CrewBoard', id: 'wake-declare', input: { op: 'post', clientOpId: 'built-wait', kind: 'ask', text: '@main wake me when about built-trigger' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'StructuredOutput', id: 'wake-first-schema', input: { phase: 'waiting' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'text', text: 'BUILT-WORKER-PARKED', whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'Bash', id: 'wake-second-pwd', input: { command: 'pwd', description: 'Read the retained directory' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'StructuredOutput', id: 'wake-second-schema', input: { phase: 'resumed' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'text', text: 'BUILT-WORKER-WOKE', whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'Crewmate', id: 'wake-launch', input: { name: 'wake-target', description: 'Wait for the board subject', prompt: 'wake-child-only. Read your directory, declare the subject wait, and finish.', crewmate_type: 'mercury-crew', run_in_background: true, model: childModel, effort: 'max', isolation: 'worktree', output_schema: schema }, whenModel: 'fable-5-1', model: LEAD_MODEL },
    ...Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'BUILT-LEAD-IDLE', whenModel: 'fable-5-1', model: LEAD_MODEL })),
  ])
  execFileSync('git', ['init', world.project], { stdio: 'pipe' })
  execFileSync('git', ['-C', world.project, 'add', 'README.md'], { stdio: 'pipe' })
  execFileSync('git', ['-C', world.project, 'commit', '-m', 'fixture'], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })
  const settings = join(world.config, 'settings.json')
  writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
  const session = bootLead(world, ['--sovereign'], ['Crewmate', 'CrewBoard', 'Bash'])
  const { open } = await import('../../src/services/crewBoard/store.ts')
  let live: ReturnType<typeof open> | undefined
  const childRequests = () => world.fixture.messageRequests().filter(request => (request.body as { model?: string }).model === childModel)
  try {
    session.submit('/swarm on')
    await session.waitFor('the built wave opens', () => session.stdout().includes('Swarm on for new crewmates'))
    session.submit('wake-parent-only: launch the worker, then wait.')
    await session.waitFor('the worker declares its wait', () => toolResultOf(world, 'wake-declare') !== null)
    const path = findFiles(world.config, 'board.sqlite')[0]!
    const sid = dirname(dirname(dirname(path))).split(/[\\/]/).at(-1)!
    live = open(path, sid)
    await session.waitFor('the worker parks after its first response', () => live!.seats().some(seat => seat.name === 'wake-target' && seat.state === 'parked' && seat.wait !== undefined) && childRequests().some(request => JSON.stringify(request.body).includes('wake-first-schema')))
    const target = live.seats().find(seat => seat.name === 'wake-target')!
    const before = childRequests().length
    const firstBody = childRequests()[0]!.body as { system?: unknown; tools?: { name?: string; input_schema?: unknown }[]; output_config?: unknown }
    const metaPath = findFiles(world.config, `agent-${target.agent}.meta.json`)[0]!
    const metadata = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert(metadata.worktreePath)
    const sender = { author: { sessionId: sid, agentId: 'fixture-poster', executionId: 'fixture' }, name: 'Fixture poster' }
    live.enroll(sender)
    const posted = live.post(sender, { clientOpId: 'built-trigger', kind: 'result', about: 'built-trigger', text: 'BUILT-WAKE-PACKET' })
    assert(posted.ok)
    assert(live.post(sender, { clientOpId: 'built-trigger', kind: 'result', about: 'built-trigger', text: 'BUILT-WAKE-PACKET' }).ok)
    await session.waitFor('the real resumed worker submits its existing schema', () => toolResultOf(world, 'wake-second-schema') !== null)
    await session.waitFor('the resumed worker completes once', () => live!.seats().find(seat => seat.agent === target.agent)?.state === 'parked' && live!.view().peerTurns === 1)
    const resumed = childRequests().slice(before)
    assert(resumed.length)
    const resumedBody = resumed[0]!.body as { system?: unknown; tools?: { name?: string; input_schema?: unknown }[]; output_config?: unknown; messages?: unknown[] }
    const wire = JSON.stringify(resumedBody.messages)
    check('the built runner resumes from the transcript with exactly one triggering body', wire.includes('BUILT-WORKER-PARKED') && wire.split('BUILT-WAKE-PACKET').length === 2 && live.view().peerTurns === 1)
    check('the resumed request keeps model, max effort, system prefix and output schema', (resumed[0]!.body as { model?: string }).model === childModel && JSON.stringify(firstBody.output_config) === JSON.stringify(resumedBody.output_config) && JSON.stringify(firstBody.system) === JSON.stringify(resumedBody.system) && JSON.stringify(firstBody.tools?.find(tool => tool.name === 'StructuredOutput')?.input_schema) === JSON.stringify(resumedBody.tools?.find(tool => tool.name === 'StructuredOutput')?.input_schema))
    const firstPwd = toolResultOf(world, 'wake-first-pwd'), secondPwd = toolResultOf(world, 'wake-second-pwd')
    check('the same recorded worktree and callable output schema survive the wake', !firstPwd?.isError && !secondPwd?.isError && firstPwd?.text.includes(metadata.worktreePath) && secondPwd?.text.includes(metadata.worktreePath) && toolResultOf(world, 'wake-second-schema')?.isError === false)
    check('the one-shot wait is consumed and the worker retains its identity', live.seats().filter(seat => seat.name === 'wake-target').length === 1 && live.seats().find(seat => seat.agent === target.agent)?.wait === undefined)
    const node = live.screenEvents(0).filter(event => event.author.agentId === target.agent && event.lifecycle)
    check('a real completed run contributes one parked row and its resumed run one Done', node.filter(event => event.lifecycle?.kind === 'parked').length === 1 && node.filter(event => event.lifecycle?.kind === 'done').length === 1)
    assert.equal(await session.end(), 0, session.stderr())
  } finally {
    record('parked-wake-out.txt', session.stdout())
    record('parked-wake-requests.json', JSON.stringify(childRequests().map(request => request.body)))
    live?.close()
    await session.terminate()
    await closeWorld(world)
  }
}
console.log(`${checks} parked-wake checks passed`)

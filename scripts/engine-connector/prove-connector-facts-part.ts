#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionFactsV1 } from '../../src/engine/connector/seatProjections.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const scratch = mkdtempSync(join(tmpdir(), 'connector-facts-part-'))
const plane = join(scratch, 'daemon')
const home = join(scratch, 'home')
for (const dir of [plane, home]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = plane
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { FactsPart } = await import('../../src/engine/connector/daemon/facts.ts')
const { publishSessionFacts, readSessionFacts, sessionFactsPath } = await import('../../src/engine/connector/seatProjections.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')

const PART = 'src/engine/connector/daemon/facts.ts'
let failures = 0
const WHERE = 'the part under test is FactsPart in src/engine/connector/daemon/facts.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const same = (a: unknown, b: unknown): boolean => j(a) === j(b)

type World = { sessionId: string; model: string | undefined; effort: string | undefined; cwd: string; projectRoot: string; awaiting: boolean }
type Seen = { usage: unknown[]; lists: Array<{ fetchedAtMs: number }>; woken: string[] }
type Built = { facts: InstanceType<typeof FactsPart>; world: World; seen: Seen }
function part(sessionId: string, over: Partial<World> = {}): Built {
  const world: World = { sessionId, model: 'claude-sonnet-5-5', effort: 'high', cwd: '/record/worktree', projectRoot: '/record/workspace', awaiting: false, ...over }
  const seen: Seen = { usage: [], lists: [], woken: [] }
  const facts = new FactsPart({
    sessionId: () => world.sessionId,
    recordModel: () => world.model,
    recordEffort: () => world.effort,
    recordWorkspace: () => ({ cwd: world.cwd, projectRoot: world.projectRoot }),
    awaitingRunner: () => world.awaiting,
    adoptUsage: usage => void seen.usage.push(usage),
    adoptOpenaiCatalogue: list => void seen.lists.push(list),
  })
  facts.subscribeModel(() => seen.woken.push('model'))
  facts.subscribePermissionMode(() => seen.woken.push('permission'))
  return { facts, world, seen }
}

const USAGE = { totalCostUSD: 1.25, totalAPIDurationMs: 10, totalDurationMs: 20, totalLinesAdded: 3, totalLinesRemoved: 4, totalInputTokens: 5, totalOutputTokens: 6, totalCacheReadInputTokens: 7, totalCacheCreationInputTokens: 8, hasUnknownModelCost: false }
const NO_USAGE = { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }
const IDENTITY = { firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: 'seat@example.test' }
const NO_IDENTITY = { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }
const WORKSPACE = { cwd: '/facts/cwd', originalCwd: '/facts/original', projectRoot: '/facts/root' }
const SWITCHES = { subagents: { on: false, source: 'session' }, workflows: { on: true, source: 'default' } }
const BOTH_ON = { subagents: { on: true, source: 'default' }, workflows: { on: true, source: 'default' } }
const ROW = { id: 'agent-1', agentId: 'agent-1', kind: 'agent', name: 'the errand', status: 'running', startTime: 1 }
const list = (fetchedAtMs: number): { sourceKind: string; models: unknown[]; fetchedAtMs: number } => ({ sourceKind: 'api-key', models: [], fetchedAtMs })

function says(sessionId: string, atMs: number, extra: Record<string, unknown> = {}): SessionFactsV1 {
  publishSessionFacts({ schema: 1, sessionId, atMs, pendingModel: null, busy: false, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, usage: USAGE, identity: IDENTITY, skills: [], mcp: [], permissionMode: 'default', workspace: WORKSPACE, queue: [], ...extra } as never)
  return readSessionFacts(sessionId)!
}
function reads(built: Built, next: SessionFactsV1, held: SessionFactsV1 = next): { prev: SessionFactsV1 | null; modelMoved: boolean; modeMoved: boolean; busy: boolean; woken: string } {
  built.seen.woken.length = 0
  const taken = built.facts.take(next, held)
  built.facts.handOn(next, taken.prev)
  const busy = built.facts.followBusy()
  built.facts.wake(taken.modelMoved, taken.modeMoved)
  return { ...taken, busy, woken: built.seen.woken.splice(0).join(' ') }
}

section('§1 with no facts published the part answers what the record and the defaults say')
{
  const { facts, world } = part('facts-part-none')
  check('no facts are held and the busy word is false', facts.read() === null && facts.busy() === false, j({ read: facts.read(), busy: facts.busy() }))
  check('usage reads ten zeroes and no unknown cost', same(facts.usage(), NO_USAGE), j(facts.usage()))
  check('identity reads no billing and no address', same(facts.identity(), NO_IDENTITY), j(facts.identity()))
  check('edit outcomes, the advisor, the swarm board and the store failure read null; the watchdog is not said', facts.editOutcomes() === null && facts.advisorFacts() === null && facts.swarmBoard() === null && facts.transcriptStoreFailing() === null && facts.streamIdleTimeoutMs() === undefined, j([facts.editOutcomes(), facts.advisorFacts(), facts.swarmBoard(), facts.transcriptStoreFailing(), facts.streamIdleTimeoutMs()]))
  check('the skills and the MCP rosters are empty', same(facts.skillsRoster(), { skills: [] }) && same(facts.mcpRoster(), { clients: [] }), j([facts.skillsRoster(), facts.mcpRoster()]))
  check('both spawn switches read on, by default', same(facts.spawnSwitches(), BOTH_ON), j(facts.spawnSwitches()))
  check("the workspace is the record's: its folder twice and its project root", same(facts.workspace(), { cwd: '/record/worktree', originalCwd: '/record/worktree', projectRoot: '/record/workspace' }), j(facts.workspace()))
  check("the model is the record's, said as recorded, with the record's effort and no parked switch", same(facts.modelFacts(), { effective: 'claude-sonnet-5-5', effectiveSource: 'record', main: 'claude-sonnet-5-5', setting: 'claude-sonnet-5-5', sessionPin: 'claude-sonnet-5-5', effort: 'high', pendingSwitch: null }), j(facts.modelFacts()))
  world.model = undefined
  world.effort = undefined
  check("with no model on the record the model is this process's own, said as ambient, with no setting and no effort", same(facts.modelFacts(), { effective: getEngineModel(), effectiveSource: 'ambient', main: getEngineModel(), setting: null, sessionPin: null, effort: null, pendingSwitch: null }), j(facts.modelFacts()))
}

section('§2 over published facts every answer is the published one')
{
  const sid = 'facts-part-published'
  says(sid, 100, { editOutcomes: [{ path: '/a.ts', outcome: 'kept' }], advisor: { model: 'claude-opus-5', state: 'on' }, swarm: { on: true, snapshot: 'board-1' }, transcriptStoreFailing: 'the store is full', streamIdleTimeoutMs: 90_000, skills: [{ name: 'a-skill' }], mcp: [{ name: 'a-server' }], spawnSwitches: SWITCHES, effort: 'xhigh', effortSent: null, pendingModel: 'gpt-6.2-sol', busy: true, work: [ROW] })
  const built = part(sid)
  const { facts, world } = built
  const seed = facts.read()
  check('the part read the file at construction: the facts held are the published ones, and the busy word is theirs', seed !== null && seed.atMs === 100 && facts.busy() === true, j({ atMs: seed?.atMs, busy: facts.busy() }))
  check('usage and identity are the published ones', same(facts.usage(), USAGE) && same(facts.identity(), IDENTITY), j([facts.usage(), facts.identity()]))
  check('edit outcomes, the advisor, the swarm board, the store failure and the watchdog are the published ones', same(facts.editOutcomes(), [{ path: '/a.ts', outcome: 'kept' }]) && same(facts.advisorFacts(), { model: 'claude-opus-5', state: 'on' }) && same(facts.swarmBoard(), { on: true, snapshot: 'board-1' }) && facts.transcriptStoreFailing() === 'the store is full' && facts.streamIdleTimeoutMs() === 90_000, j([facts.editOutcomes(), facts.advisorFacts(), facts.swarmBoard(), facts.transcriptStoreFailing(), facts.streamIdleTimeoutMs()]))
  check('the rosters and the spawn switches are the published ones', same(facts.skillsRoster(), { skills: [{ name: 'a-skill' }] }) && same(facts.mcpRoster(), { clients: [{ name: 'a-server' }] }) && same(facts.spawnSwitches(), SWITCHES), j([facts.skillsRoster(), facts.mcpRoster(), facts.spawnSwitches()]))
  check("the workspace is the facts' own, not the record's", same(facts.workspace(), WORKSPACE), j(facts.workspace()))
  check('the model is the one that serves, said as live, with the published effort, the word the runner sends and the parked switch', same(facts.modelFacts(), { effective: 'claude-opus-5', effectiveSource: 'live', main: 'claude-opus-5', setting: 'claude-opus-5', sessionPin: 'claude-opus-5', effort: 'xhigh', effortSent: null, pendingSwitch: { setting: 'gpt-6.2-sol' } }), j(facts.modelFacts()))
  world.awaiting = true
  check("while the runner has not answered, the record's model stands over the facts' and is said as recorded", facts.modelFacts().effective === 'claude-sonnet-5-5' && facts.modelFacts().setting === 'claude-sonnet-5-5' && facts.modelFacts().sessionPin === 'claude-sonnet-5-5' && facts.modelFacts().effectiveSource === 'record', j(facts.modelFacts()))
  world.awaiting = false
  const plain = reads(built, says(sid, 101, { model: { effective: 'claude-opus-5', setting: null }, streamIdleTimeoutMs: '90000' }))
  check("facts with no setting and no effort read the record's for both, with no word sent and no parked switch", plain.prev === seed && same(facts.modelFacts(), { effective: 'claude-opus-5', effectiveSource: 'live', main: 'claude-opus-5', setting: 'claude-sonnet-5-5', sessionPin: 'claude-sonnet-5-5', effort: 'high', pendingSwitch: null }), j(facts.modelFacts()))
  check('a watchdog the facts spell as text is not said', facts.streamIdleTimeoutMs() === undefined, `${j(facts.streamIdleTimeoutMs())} — streamIdleTimeoutMs of ${PART} answers a number or nothing`)
}

section('§3 what a read hands on: the usage every time, the OpenAI list once for each stamp')
{
  const sid = 'facts-part-hands'
  const built = part(sid)
  const first = reads(built, says(sid, 1, { openaiCatalogue: list(500) }))
  check('the first read with no seed finds no facts before it and hands on the usage and the list', first.prev === null && built.seen.usage.length === 1 && same(built.seen.usage[0], USAGE) && built.seen.lists.length === 1 && built.seen.lists[0]!.fetchedAtMs === 500, j({ usage: built.seen.usage.length, lists: built.seen.lists }))
  reads(built, says(sid, 2, { openaiCatalogue: list(500), usage: { ...USAGE, totalCostUSD: 2 } }))
  check('two reads of one list hand it on once', built.seen.lists.length === 1, `${built.seen.lists.length} hand-overs of the list with the stamp 500 — handOn of ${PART} hands the list to needs.adoptOpenaiCatalogue only when its fetchedAtMs differs from the facts before`)
  check('…and the usage at each read, as that read published it', built.seen.usage.length === 2 && same(built.seen.usage[1], { ...USAGE, totalCostUSD: 2 }), `${built.seen.usage.length} hand-overs of the usage over 2 reads: ${j(built.seen.usage)} — handOn of ${PART} calls needs.adoptUsage at every read`)
  reads(built, says(sid, 3, { openaiCatalogue: list(900) }))
  check('a list whose stamp moved is handed on again: two hand-overs across the two lists', built.seen.lists.length === 2 && built.seen.lists[1]!.fetchedAtMs === 900, j(built.seen.lists))
  reads(built, says(sid, 4))
  check('facts with no list hand on none, and the usage still', built.seen.lists.length === 2 && built.seen.usage.length === 4, j({ lists: built.seen.lists.length, usage: built.seen.usage.length }))
  reads(built, says(sid, 5, { openaiCatalogue: list(900) }))
  check('the same list back after facts without one is handed on again', built.seen.lists.length === 3, j(built.seen.lists))

  const seeded = 'facts-part-seeded'
  says(seeded, 10, { openaiCatalogue: list(700) })
  const over = part(seeded)
  check('construction over facts that carry a usage and a list hands on neither: the seed is held, not read', over.seen.usage.length === 0 && over.seen.lists.length === 0 && over.facts.read()?.atMs === 10, j({ usage: over.seen.usage.length, lists: over.seen.lists.length }))
  const again = reads(over, says(seeded, 10, { openaiCatalogue: list(700) }))
  check('the first read after it finds the seed before it, hands on the usage, and nothing of the model or the mode has moved', again.prev !== null && again.prev.atMs === 10 && over.seen.usage.length === 1 && again.modelMoved === false && again.modeMoved === false, j({ prev: again.prev?.atMs, usage: over.seen.usage.length, modelMoved: again.modelMoved, modeMoved: again.modeMoved }))
  check('…and hands on the list the seed held, though its stamp is the seed\'s own: a window opened on facts that carry a list primes the catalogue at its first read', over.seen.lists.length === 1 && over.seen.lists[0]!.fetchedAtMs === 700, `${j(over.seen.lists)} — handOn of ${PART} hands the list on at the first read after a seed, whatever the stamp of the facts before`)
  reads(over, says(seeded, 11, { openaiCatalogue: list(700) }))
  check('a second read of that list hands on nothing more', over.seen.lists.length === 1, j(over.seen.lists))
}

section('§4 the two channels: which wakes, and in what order')
{
  const sid = 'facts-part-channels'
  const built = part(sid)
  const first = reads(built, says(sid, 1))
  check('the first read with nothing before it counts both as moved: the model listeners, then the mode listeners', first.modelMoved && first.modeMoved && first.woken === 'model permission', j(first))
  const still = reads(built, says(sid, 2))
  check('a read where nothing moved wakes the model listeners once and the mode listeners not at all', !still.modelMoved && !still.modeMoved && still.woken === 'model', j(still))
  const mode = reads(built, says(sid, 3, { permissionMode: 'implement' }))
  check('a read where the mode moved alone wakes the mode listeners first, then the model listeners', !mode.modelMoved && mode.modeMoved && mode.woken === 'permission model', `${j(mode)} — wake of ${PART} keeps the three statements in their order`)
  const both = reads(built, says(sid, 4, { permissionMode: 'default', model: { effective: 'claude-haiku-5', setting: 'claude-opus-5' } }))
  check('a read where the model and the mode moved wakes the model listeners first, then the mode listeners', both.modelMoved && both.modeMoved && both.woken === 'model permission', j(both))
  const moves: Array<[string, Record<string, unknown>]> = [
    ['the model that serves', { model: { effective: 'claude-opus-5', setting: 'claude-opus-5' } }],
    ['the setting', { model: { effective: 'claude-opus-5', setting: null } }],
    ['the parked switch', { model: { effective: 'claude-opus-5', setting: null }, pendingModel: 'gpt-6.2-sol' }],
    ['the effort', { model: { effective: 'claude-opus-5', setting: null }, pendingModel: 'gpt-6.2-sol', effort: 'low' }],
    ['the word the runner sends', { model: { effective: 'claude-opus-5', setting: null }, pendingModel: 'gpt-6.2-sol', effort: 'low', effortSent: 'low' }],
  ]
  const told = moves.map(([what, extra], at) => [what, reads(built, says(sid, 10 + at, extra))] as const)
  const missed = told.filter(([, read]) => !(read.modelMoved && !read.modeMoved && read.woken === 'model'))
  check('each of the five model facts that moves alone counts as the model moving and wakes the model listeners once: the model that serves, the setting, the parked switch, the effort, the word the runner sends', missed.length === 0, `not counted: ${missed.map(([what, read]) => `${what} ${j(read)}`).join(' · ')} — take of ${PART} compares all five with the facts before`)
  built.seen.woken.length = 0
  built.facts.wakeModel()
  check('wakeModel wakes the model listeners once and no other', built.seen.woken.join(' ') === 'model', built.seen.woken.join(' '))
  const heard: string[] = []
  const offModel = built.facts.subscribeModel(() => heard.push('model'))
  const offMode = built.facts.subscribePermissionMode(() => heard.push('permission'))
  offModel()
  offMode()
  reads(built, says(sid, 30, { permissionMode: 'implement', model: { effective: 'claude-haiku-5', setting: null } }))
  check('a listener that let go is not woken again', heard.length === 0, heard.join(' '))
}

section('§5 the busy word and the facts are two things: one drops without the other')
{
  const sid = 'facts-part-busy'
  const built = part(sid)
  const { facts } = built
  const busy = reads(built, says(sid, 1, { busy: true, work: [ROW], mission: [{ id: 'm1' }], samples: [{ id: 's1' }] }))
  check('a read of busy facts sets the busy word', busy.busy === true && facts.busy() === true, j(busy))
  facts.dropBusy()
  check('dropBusy drops the word and leaves the facts, their stamp and their rows as they were', facts.busy() === false && facts.read()?.busy === true && facts.read()?.atMs === 1 && facts.read()?.work?.length === 1, j({ word: facts.busy(), facts: { busy: facts.read()?.busy, atMs: facts.read()?.atMs, work: facts.read()?.work?.length } }))
  check('followBusy takes the word from the facts held again', facts.followBusy() === true && facts.busy() === true, j(facts.busy()))
  facts.strip()
  check('strip empties the work, the mission and the samples of the facts and says them idle, under the same stamp, and leaves the word', facts.read()?.busy === false && same([facts.read()?.work, facts.read()?.mission, facts.read()?.samples], [[], [], []]) && facts.read()?.atMs === 1 && facts.busy() === true, j({ word: facts.busy(), facts: facts.read() }))
  const next = says(sid, 2, { busy: true, work: [ROW] })
  const latched = reads(built, next, { ...next, busy: false, work: [], mission: [], samples: [] })
  check("the facts held are what the carrier's latch answered, not what was published: idle, with no rows", latched.busy === false && facts.read()?.busy === false && facts.read()?.work?.length === 0, `${j({ busy: latched.busy, held: { busy: facts.read()?.busy, work: facts.read()?.work?.length } })} — take of ${PART} holds its second argument`)
  reads(built, says(sid, 3, { busy: true, work: [ROW], mission: [{ id: 'm1' }], samples: [{ id: 's1' }] }))
  check('with the file standing, dropRowsWithNoFile drops nothing and says so', facts.dropRowsWithNoFile() === false && facts.read()?.work?.length === 1, j(facts.read()?.work))
  rmSync(sessionFactsPath(sid), { force: true })
  const dropped = facts.dropRowsWithNoFile()
  check('with the file gone it drops the three kinds of rows, says so, and leaves the busy facts and the word', dropped === true && same([facts.read()?.work, facts.read()?.mission, facts.read()?.samples], [[], [], []]) && facts.read()?.busy === true && facts.busy() === true, j({ dropped, facts: facts.read(), word: facts.busy() }))
  check('…and a second time there is nothing to drop', facts.dropRowsWithNoFile() === false)
  const none = part('facts-part-busy-none')
  none.facts.strip()
  check('with no facts held, strip and dropRowsWithNoFile do nothing', none.facts.read() === null && none.facts.dropRowsWithNoFile() === false && none.facts.followBusy() === false)
}

section('§6 what the screen is shown before the carrier answers, and how it is taken back')
{
  const sid = 'facts-part-shown'
  const built = part(sid)
  const { facts, seen } = built
  reads(built, says(sid, 1, { effort: 'high' }))
  seen.woken.length = 0
  facts.showModel('gpt-6.2-sol', false)
  check('showModel at rest shows the model as serving and as the setting, with no parked switch, and wakes the model listeners once', facts.read()?.model.effective === 'gpt-6.2-sol' && facts.read()?.model.setting === 'gpt-6.2-sol' && facts.read()?.pendingModel === null && seen.woken.join(' ') === 'model', j({ model: facts.read()?.model, pendingModel: facts.read()?.pendingModel, woken: seen.woken }))
  seen.woken.length = 0
  facts.showModel('claude-haiku-5', true)
  check('showModel during a turn parks the switch and leaves the model that serves, and wakes the model listeners once', facts.read()?.model.effective === 'gpt-6.2-sol' && facts.read()?.pendingModel === 'claude-haiku-5' && facts.modelFacts().pendingSwitch?.setting === 'claude-haiku-5' && seen.woken.join(' ') === 'model', j({ model: facts.read()?.model, pendingModel: facts.read()?.pendingModel, woken: seen.woken }))
  seen.woken.length = 0
  facts.showEffort('low', true)
  check('showEffort during a turn shows nothing and wakes no one', facts.read()?.effort === 'high' && seen.woken.length === 0, j({ effort: facts.read()?.effort, woken: seen.woken }))
  facts.showEffort('low', false)
  check('showEffort at rest shows the level and wakes the model listeners once', facts.read()?.effort === 'low' && facts.modelFacts().effort === 'low' && seen.woken.join(' ') === 'model', j({ effort: facts.read()?.effort, woken: seen.woken }))
  seen.woken.length = 0
  const stood = facts.read()
  const before = facts.showMode('implement')
  check('showMode shows the mode, wakes the mode listeners once, and answers the facts as they stood', before === stood && before?.permissionMode === 'default' && facts.read()?.permissionMode === 'implement' && seen.woken.join(' ') === 'permission', j({ before: before?.permissionMode, now: facts.read()?.permissionMode, woken: seen.woken }))
  seen.woken.length = 0
  facts.restoreMode(before, 'implement')
  check('restoreMode puts back the facts that stood and wakes the mode listeners once', facts.read() === stood && seen.woken.join(' ') === 'permission', j({ now: facts.read()?.permissionMode, woken: seen.woken }))
  const shown = facts.showMode('implement')
  reads(built, says(sid, 2, { permissionMode: 'sovereign' }))
  seen.woken.length = 0
  facts.restoreMode(shown, 'implement')
  check('restoreMode leaves facts whose mode has moved on since, and wakes no one', facts.read()?.permissionMode === 'sovereign' && facts.read()?.atMs === 2 && seen.woken.length === 0, j({ now: facts.read()?.permissionMode, atMs: facts.read()?.atMs, woken: seen.woken }))

  const none = part('facts-part-shown-none')
  none.facts.showModel('gpt-6.2-sol', false)
  none.facts.showEffort('low', false)
  const nothing = none.facts.showMode('implement')
  none.facts.restoreMode(nothing, 'implement')
  check('with no facts held nothing is shown, nothing is answered and no one is woken', none.facts.read() === null && nothing === null && none.seen.woken.length === 0, j({ read: none.facts.read(), woken: none.seen.woken }))

  const again = 'facts-part-seed-again'
  says(again, 5, { busy: true })
  const parked = part(again)
  says(again, 6, { busy: false, model: { effective: 'claude-haiku-5', setting: null }, openaiCatalogue: list(800) })
  parked.seen.woken.length = 0
  parked.facts.seedAgain()
  check('seedAgain holds the file as it stands now, keeps the busy word it had, hands nothing on and wakes no one', parked.facts.read()?.atMs === 6 && parked.facts.busy() === true && parked.seen.usage.length === 0 && parked.seen.lists.length === 0 && parked.seen.woken.length === 0, j({ atMs: parked.facts.read()?.atMs, word: parked.facts.busy(), usage: parked.seen.usage.length, lists: parked.seen.lists.length, woken: parked.seen.woken }))
  reads(parked, says(again, 7, { busy: false, model: { effective: 'claude-haiku-5', setting: null }, openaiCatalogue: list(800) }))
  reads(parked, says(again, 8, { busy: false, model: { effective: 'claude-haiku-5', setting: null }, openaiCatalogue: list(800) }))
  check('the first read after it hands on the list it held, and the read after that nothing more', parked.seen.lists.length === 1 && parked.seen.lists[0]!.fetchedAtMs === 800, j(parked.seen.lists))
  rmSync(sessionFactsPath(again), { force: true })
  parked.facts.seedAgain()
  check('…and with the file gone it keeps the facts it held', parked.facts.read()?.atMs === 8, j(parked.facts.read()?.atMs))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-connector-facts-part: the facts part answers, hands on and wakes as the door needs' : `\nprove-connector-facts-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

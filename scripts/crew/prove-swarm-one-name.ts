import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import type { BoardPrincipal, BoardStore } from '../../src/services/crewBoard/contracts.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'one-name-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const selected = process.argv.indexOf('--case')
const only = selected < 0 ? undefined : process.argv[selected + 1]
assert(selected < 0 || only, '--case needs a case name')
let checks = 0
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  if (only && only !== name) return
  await run()
  checks++
  console.log(`PASS ${name}`)
}
const RUNNING = (name: string): { message: string } => ({ message: `A seat named ${name} is running on this board; stop it, or launch this one under another name.` })
type World = {
  board: BoardStore
  main: BoardPrincipal
  launch: (id: string, name: string, extra?: { team?: string; captain?: boolean; named?: boolean }) => BoardPrincipal
  run: (seat: BoardPrincipal, execution: string) => BoardPrincipal
  park: (seat: BoardPrincipal) => void
  say: (seat: BoardPrincipal, text: string, kind?: 'result' | 'ask') => { ok: boolean; reason?: string; reach?: { running: string[]; wakes: string[]; held: string[]; parked: number } }
  roster: () => string[]
  woken: () => string[]
}
async function world(name: string, run: (w: World) => void | Promise<void>, live?: (agent: string) => boolean): Promise<void> {
  let now = 0, serial = 0
  const board = open(join(home, `${name}.sqlite`), name, () => (now += 15000), false, live)
  const principal = (id: string, display: string, execution: string, team?: string): BoardPrincipal => ({ author: { sessionId: name, agentId: id, executionId: execution }, name: display, ...(team ? { team } : {}) })
  const main = principal('main', 'main', 'lead')
  board.enroll(main)
  const w: World = {
    board,
    main,
    launch(id, display, extra = {}) {
      board.reserveEnrollment(w.main, { agent: id, name: display, team: extra.team, captain: extra.captain, named: extra.named ?? true })
      const seat = principal(id, display, `${id}-1`, extra.team)
      board.enroll(seat)
      return seat
    },
    run(seat, execution) {
      const again = { ...seat, author: { ...seat.author, executionId: execution } }
      board.enroll(again)
      return again
    },
    park(seat) { board.complete(seat, 'completed') },
    say(seat, text, kind = 'result') { return board.post(seat, { clientOpId: `p${++serial}`, kind, text }) as ReturnType<World['say']> },
    roster: () => board.seats().filter(seat => seat.agent !== 'main').map(seat => `${seat.name}=${seat.agent}:${seat.state}`),
    woken: () => board.pendingWakes().map(wake => wake.agent),
  }
  try { await run(w) } finally { board.close() }
}

await check('one-mention-one-wake', () => world('one-mention-one-wake', w => {
  const old = w.launch('old', 'reviewer', { team: 'review' })
  const peer = w.launch('peer', 'peer')
  w.park(old)
  const rows = w.board.view().snapshot
  w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'reviewer', team: 'review', named: true })
  assert.equal(w.board.view().snapshot, rows, 'the retirement writes no row on the board')
  assert.deepEqual(w.roster(), ['peer=peer:running'], 'the parked seat left the roster when the launch took its name')
  const fresh: BoardPrincipal = { author: { sessionId: 'one-mention-one-wake', agentId: 'fresh', executionId: 'fresh-1' }, name: 'reviewer', team: 'review' }
  w.board.enroll(fresh)
  assert.deepEqual(w.roster(), ['peer=peer:running', 'reviewer=fresh:running'])
  const live = w.say(peer, '@reviewer the sha is ready')
  assert.deepEqual(live.reach, { running: ['reviewer'], wakes: [], held: [], parked: 0 })
  assert.deepEqual(w.woken(), [], 'a post that names the running seat wakes nobody')
  w.park(fresh)
  const parked = w.say(peer, '@reviewer a second sha')
  assert.deepEqual(parked.reach, { running: [], wakes: ['reviewer'], held: [], parked: 0 })
  assert.deepEqual(w.woken(), ['fresh'], 'one post that names the seat queues exactly one wake, the newest holder\'s')
  assert.deepEqual(w.say(old, 'the old execution posts'), { ok: false, reason: 'This seat is not enrolled in this wave.' })
}))

await check('its-own-wait-and-queued-wake-leave-with-it', () => world('own-wait', w => {
  const old = w.launch('old', 'reviewer')
  const peer = w.launch('peer', 'peer')
  assert(w.say(old, '@main wake me when kind result', 'ask').ok)
  w.park(old)
  w.say(peer, 'a result nobody is named in')
  assert.deepEqual(w.woken(), ['old'], 'the wait it declared has queued its wake')
  w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'reviewer', named: true })
  assert.deepEqual(w.woken(), [], 'the queued wake is dropped with the enrollment, before the new seat has joined')
  assert.equal(w.board.claimWake(w.main, { agent: 'old', eventId: 'any', seq: 0, version: 0 }), null)
  w.board.enroll({ author: { sessionId: 'own-wait', agentId: 'fresh', executionId: 'fresh-1' }, name: 'reviewer' })
  w.say(peer, 'another result nobody is named in')
  w.say(peer, '@reviewer and one that names the seat')
  assert.deepEqual(w.woken(), [], 'neither its wait nor its name wakes the retired seat again')
  assert.equal(w.board.seats().some(seat => seat.agent === 'old'), false)
}))

await check('waits-on-the-seat-follow-the-name', () => world('waits-follow', w => {
  const old = w.launch('old', 'reviewer')
  const peer = w.launch('peer', 'peer')
  assert(w.say(peer, '@main wake me when seat reviewer posts', 'ask').ok)
  w.park(peer)
  w.park(old)
  const fresh = w.launch('fresh', 'reviewer')
  const wait = w.board.seats().find(seat => seat.agent === 'peer')?.wait
  assert.deepEqual(wait?.predicate, { kind: 'seat', agent: 'fresh', name: 'reviewer' })
  w.say(fresh, 'the new seat posts')
  assert.deepEqual(w.woken(), ['peer'], 'the seat that waits on the name is woken by its new holder')
}))

await check('the-captaincy-follows-the-name', () => world('captaincy', w => {
  const old = w.launch('old', 'lead-eng', { team: 'engine', captain: true })
  const member = w.launch('member', 'member', { team: 'engine' })
  assert.equal(w.board.captain('engine')?.agent, 'old')
  w.park(old)
  const seen = w.board.boundary(member, new Set())
  if (seen) w.board.presented(member, seen.eventIds, 'before')
  w.launch('fresh', 'lead-eng', { team: 'engine' })
  assert.equal(w.board.captain('engine')?.agent, 'fresh')
  assert.equal(w.board.seats().find(seat => seat.agent === 'fresh')?.captain, true)
  assert(w.board.boundary(member, new Set())?.text.includes('captain lead-eng'), 'the team is told its captain, as at any appointment')
  w.park(w.board.seats().find(seat => seat.agent === 'fresh') ? { author: { sessionId: 'captaincy', agentId: 'fresh', executionId: 'fresh-1' }, name: 'lead-eng', team: 'engine' } : old)
  w.launch('moved', 'lead-eng', { team: 'view' })
  assert.equal(w.board.captain('engine'), undefined, 'a seat relaunched into another team leaves its old team without a captain')
  assert.equal(w.board.captain('view'), undefined)
  assert.equal(w.board.assignCaptain(w.main, 'engine', 'member').ok, true, 'and no stale row stands in the way of the next appointment')
}))

await check('a-launch-that-fails-puts-the-seat-back', () => world('put-back', w => {
  const old = w.launch('old', 'reviewer', { team: 'review', captain: true })
  const peer = w.launch('peer', 'peer')
  assert(w.say(old, '@main wake me when kind result', 'ask').ok)
  w.park(old)
  w.say(peer, 'a result')
  const before = { roster: w.roster(), woken: w.woken(), captain: w.board.captain('review')?.agent, wait: w.board.seats().find(seat => seat.agent === 'old')?.wait }
  assert.deepEqual(before.woken, ['old'])
  let told = 0
  const quiet = w.board.subscribe(() => { told++ })
  w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'reviewer', team: 'review', named: true })
  assert.deepEqual(w.roster(), ['peer=peer:running'])
  assert.equal(told, 1, 'a reader of the roster is told when the seat leaves it')
  w.board.cancelEnrollment(w.main, 'fresh')
  assert.equal(told, 2, 'and when it is put back')
  assert.deepEqual({ roster: w.roster(), woken: w.woken(), captain: w.board.captain('review')?.agent, wait: w.board.seats().find(seat => seat.agent === 'old')?.wait }, before, 'the seat is back as it stood: on the roster, its wait armed, its wake queued, captain of its team')
  w.board.cancelEnrollment(w.main, 'fresh')
  assert.deepEqual(w.roster(), before.roster, 'a second cancel changes nothing')
  w.board.reserveEnrollment(w.main, { agent: 'second', name: 'reviewer', team: 'review', named: true })
  assert.deepEqual(w.roster(), ['peer=peer:running'])
  w.main = { ...w.main, author: { ...w.main.author, executionId: 'lead-restarted' } }
  w.board.enroll(w.main)
  assert.deepEqual(w.roster(), before.roster, 'a lead that starts again drops the launches in flight and their retirements with them')
  quiet()
  const done = w.launch('third', 'reviewer', { team: 'review' })
  w.board.cancelEnrollment(w.main, 'third')
  assert.deepEqual(w.roster(), ['peer=peer:running', 'reviewer=third:running'], 'the cancel every launch ends with does not bring back a seat whose successor has joined')
  assert.equal(done.author.agentId, 'third')
}))

await check('refused-while-the-holder-runs', () => world('refused', w => {
  w.launch('old', 'reviewer')
  const rows = w.board.view().snapshot
  assert.throws(() => w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'reviewer', named: true }), RUNNING('reviewer'))
  assert.throws(() => w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'REVIEWER', named: true }), RUNNING('REVIEWER'))
  assert.deepEqual(w.roster(), ['reviewer=old:running'])
  assert.equal(w.board.view().snapshot, rows)
  w.board.reserveEnrollment(w.main, { agent: 'first', name: 'builder', named: true })
  assert.throws(() => w.board.reserveEnrollment(w.main, { agent: 'second', name: 'Builder', named: true }), RUNNING('Builder'), 'a second launch under a name whose first launch is still in flight')
  w.board.enroll({ author: { sessionId: 'refused', agentId: 'first', executionId: 'first-1' }, name: 'builder' })
  w.board.reserveEnrollment(w.main, { agent: 'other', name: 'another name', named: true })
  assert.deepEqual(w.roster(), ['reviewer=old:running', 'builder=first:running'])
}))

await check('names-compare-as-a-mention-does', () => world('compare', w => {
  const old = w.launch('old', 'Reviewer')
  const peer = w.launch('peer', 'peer')
  w.park(old)
  const fresh = w.launch('fresh', 'reviewer')
  w.park(fresh)
  w.say(peer, '@REVIEWER in another case')
  assert.deepEqual(w.woken(), ['fresh'])
  w.launch('near', 'reviewer-2')
  assert.deepEqual(w.roster(), ['peer=peer:running', 'reviewer=fresh:parked', 'reviewer-2=near:running'], 'a name that only begins like another is another name')
}))

await check('an-unnamed-launch-as-before', () => world('unnamed', w => {
  const old = w.launch('old', 'reviewer')
  const peer = w.launch('peer', 'peer')
  w.park(old)
  w.launch('described', 'reviewer', { named: false })
  assert.deepEqual(w.roster(), ['reviewer=old:parked', 'peer=peer:running', 'reviewer=described:running'], 'a launch that names no seat takes no name: the parked seat stays')
  w.launch('again', 'reviewer', { named: false })
  assert.equal(w.roster().length, 4, 'and is not refused while a seat of that description runs')
  w.say(peer, '@reviewer every seat of that description')
  assert.deepEqual(w.woken(), ['old'])
}))

await check('started-again-by-id', () => world('by-id', w => {
  const old = w.launch('old', 'reviewer', { team: 'review', captain: true })
  const peer = w.launch('peer', 'peer')
  assert(w.say(peer, '@main wake me when seat reviewer posts', 'ask').ok)
  w.park(peer)
  w.park(old)
  const fresh = w.launch('fresh', 'reviewer', { team: 'review' })
  assert.throws(() => w.run(old, 'old-2'), RUNNING('reviewer'), 'refused while the holder runs')
  assert.deepEqual(w.roster(), ['peer=peer:parked', 'reviewer=fresh:running'])
  assert.equal(w.board.member('old'), false)
  w.park(fresh)
  const back = w.run(old, 'old-2')
  assert.deepEqual(w.roster(), ['reviewer=old:running', 'peer=peer:parked'], 'it takes the name back from a parked holder')
  assert.equal(w.board.captain('review')?.agent, 'old')
  assert.deepEqual(w.board.seats().find(seat => seat.agent === 'peer')?.wait?.predicate, { kind: 'seat', agent: 'old', name: 'reviewer' })
  w.say(back, 'the returned seat posts')
  assert.deepEqual(w.woken(), ['peer'])
  assert.throws(() => w.run(fresh, 'fresh-2'), RUNNING('reviewer'), 'and the seat it took the name from is refused in turn while it runs')
  w.park(back)
  w.run(fresh, 'fresh-2')
  assert.deepEqual(w.roster(), ['peer=peer:parked', 'reviewer=fresh:running'])
  const parkedTwice = w.run(fresh, 'fresh-3')
  assert.deepEqual(w.roster(), ['peer=peer:parked', 'reviewer=fresh:running'], 'the holder\'s own later runs change nothing')
  w.park(parkedTwice)
  w.board.reserveEnrollment(w.main, { agent: 'third', name: 'reviewer', team: 'review', named: true })
  assert.throws(() => w.run(old, 'old-3'), RUNNING('reviewer'), 'a retired seat is not started under a name a launch in flight has taken')
}))

await check('a-run-that-is-over-holds-no-name', () => {
  const alive = new Set(['old', 'peer', 'fresh'])
  return world('run-over', w => {
    const old = w.launch('old', 'reviewer', { team: 'review', captain: true })
    const peer = w.launch('peer', 'peer')
    assert(w.say(peer, '@main wake me when seat reviewer posts', 'ask').ok)
    w.park(peer)
    assert.throws(() => w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'reviewer', team: 'review', named: true }), RUNNING('reviewer'), 'refused while the holder\'s run is alive')
    alive.delete('old')
    assert.deepEqual(w.roster(), ['reviewer=old:running', 'peer=peer:parked'], 'the board still has the seat as running: its run was stopped, or ended with its process, and nothing settled it')
    w.board.reserveEnrollment(w.main, { agent: 'fresh', name: 'reviewer', team: 'review', named: true })
    assert.deepEqual(w.roster(), ['peer=peer:parked'], 'a launch takes the name of a seat whose run is over')
    w.board.cancelEnrollment(w.main, 'fresh')
    assert.deepEqual(w.roster(), ['reviewer=old:parked', 'peer=peer:parked'], 'a launch that fails puts the seat back parked, as a run that is over leaves it')
    assert.equal(w.board.captain('review')?.agent, 'old')
    w.launch('fresh', 'reviewer', { team: 'review' })
    assert.deepEqual(w.roster(), ['peer=peer:parked', 'reviewer=fresh:running'])
    assert.equal(w.board.member('old'), false)
    assert.equal(w.board.captain('review')?.agent, 'fresh')
    assert.deepEqual(w.board.seats().find(seat => seat.agent === 'peer')?.wait?.predicate, { kind: 'seat', agent: 'fresh', name: 'reviewer' })
    assert.throws(() => w.run(old, 'old-2'), RUNNING('reviewer'), 'the seat it took the name from is refused while the new holder\'s run is alive')
    alive.delete('fresh')
    w.run(old, 'old-2')
    assert.deepEqual(w.roster(), ['reviewer=old:running', 'peer=peer:parked'], 'and takes the name back once that run is over, settled or not')
    assert.equal(w.board.captain('review')?.agent, 'old')
  }, agent => alive.has(agent))
})

await check('the-boards-own-addresses-name-no-seat', () => world('reserved', w => {
  const peer = w.launch('peer', 'peer')
  const refusals: Record<string, string> = {}
  for (const [id, name, named] of [['a', 'main', true], ['b', 'Main', false], ['c', 'all', true], ['d', ' ALL ', false]] as const) {
    try {
      w.board.reserveEnrollment(w.main, { agent: id, name, named })
      const seat: BoardPrincipal = { author: { sessionId: 'reserved', agentId: id, executionId: `${id}-1` }, name }
      w.board.enroll(seat)
      w.park(seat)
      refusals[name] = ''
    } catch (error) { refusals[name] = (error as Error).message }
  }
  w.say(peer, '@main the sha is ready')
  w.say(peer, '@all the fold is published')
  assert.deepEqual(w.woken(), [], 'no seat carries an address of the board, so a post to the lead or to the whole crew wakes no parked seat by its name')
  assert.deepEqual(refusals, { main: 'Main is reserved for the lead.', Main: 'Main is reserved for the lead.', all: 'All is reserved for the whole crew.', ' ALL ': 'All is reserved for the whole crew.' })
  assert.deepEqual(w.roster(), ['peer=peer:running'])
  assert.throws(() => w.board.enroll({ author: { sessionId: 'reserved', agentId: 'e', executionId: 'e-1' }, name: 'main' }), { message: 'Main is reserved for the lead.' })
  assert.throws(() => w.board.enroll({ author: { sessionId: 'reserved', agentId: 'all', executionId: 'f-1' }, name: 'anything' }), { message: 'All is reserved for the whole crew.' })
  assert.throws(() => w.board.reserveEnrollment(w.main, { agent: 'g', name: 'owner', named: true }), { message: 'Owner is reserved for the operator.' })
  w.board.enroll({ ...w.main, author: { ...w.main.author, executionId: 'lead-again' } })
  assert.equal(w.board.seats().find(seat => seat.agent === 'main')?.name, 'main', 'the lead itself still enrolls under its own address')
}))

await check('the-launch-and-resume-roads', async () => {
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setOriginalCwd(home); bootstrap.setCwdState(home); bootstrap.setProjectRoot(home)
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  updateSettingsForSource('userSettings', { swarm: { enabled: true } })
  const seam = await import('../../src/services/crewBoard/seam.ts')
  const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
  assert(runSwarmCommand('on').startsWith('Swarm on'))
  const board = seam.swarmStore()!
  const names = (): string[] => board.seats().filter(seat => seat.agent !== 'main').map(seat => `${seat.name}=${seat.agent}:${seat.state}`)
  const launch = async (id: string, input: { name?: string; description: string }): Promise<void> => {
    const release = seam.reserveSwarmLaunch(id, input)
    try { await seam.latchSwarmAgent(id, input.name ?? input.description) } finally { release() }
  }
  await launch('first', { name: 'solo', description: 'the first launch' })
  seam.settleSwarmAgent('first')
  assert.deepEqual(names(), ['solo=first:parked'])
  await launch('second', { name: 'solo', description: 'the second launch' })
  assert.deepEqual(names(), ['solo=second:running'], 'the tool\'s own launch of a named seat retires the parked seat of that name')
  const from = (agentId: string) => ({ agentId, toolUseId: `call-${agentId}` }) as unknown as import('../../src/Tool.ts').ToolUseContext
  await launch('third', { name: 'other', description: 'a peer' })
  assert.deepEqual(seam.swarmPeerMessage(from('third'), 'first', 'a note for the retired seat'), { handled: false }, 'a peer\'s message to the retired seat by its id is not parked on a board it no longer reads')
  await assert.rejects(seam.latchSwarmAgent('first', 'solo', false, true), RUNNING('solo'))
  assert.doesNotThrow(() => seam.settleSwarmAgent('first'), 'the refused start settles without a word from the board')
  assert.deepEqual(names(), ['solo=second:running', 'other=third:running'])
  seam.settleSwarmAgent('second')
  assert.equal(await seam.latchSwarmAgent('first', 'solo', false, true), true)
  assert.deepEqual(names(), ['solo=first:running', 'other=third:running'])
  assert.throws(() => seam.reserveSwarmLaunch('fourth', { name: 'solo', description: 'while it runs' }), RUNNING('solo'))
  const release = seam.reserveSwarmLaunch('fifth', { description: 'solo' })
  await seam.latchSwarmAgent('fifth', 'solo')
  release()
  assert.deepEqual(names(), ['solo=first:running', 'other=third:running', 'solo=fifth:running'], 'a launch that gives no name is not refused and takes none')
  const lead = seam.swarmPrincipal()!
  board.reserveEnrollment(lead, { agent: 'adrift', name: 'watch', named: true })
  board.enroll({ author: { ...lead.author, agentId: 'adrift', executionId: 'adrift-1' }, name: 'watch' })
  assert.deepEqual(names().slice(-1), ['watch=adrift:running'])
  await launch('heir', { name: 'watch', description: 'after the process that ran it ended' })
  assert.deepEqual(names().slice(-1), ['watch=heir:running'], 'a seat this process holds no run of — it was running when an earlier process ended — gives up its name to a launch')
  assert.equal(board.member('adrift'), false)
  const stop = new AbortController()
  const held = seam.reserveSwarmLaunch('sixth', { name: 'relay', description: 'a seat that is stopped' })
  try { await seam.latchSwarmAgent('sixth', 'relay', false, false, undefined, stop.signal) } finally { held() }
  assert.throws(() => seam.reserveSwarmLaunch('seventh', { name: 'relay', description: 'while it runs' }), RUNNING('relay'))
  stop.abort()
  await launch('seventh', { name: 'relay', description: 'after the stop' })
  assert.deepEqual(names().slice(-1), ['relay=seventh:running'], 'a seat whose run was told to stop gives up its name before that run has ended')
  assert.equal(board.member('sixth'), false)
  assert.doesNotThrow(() => seam.settleSwarmAgent('sixth'), 'the stopped run settles afterwards without a word from the board')
  for (const id of ['first', 'third', 'fifth', 'heir', 'seventh']) seam.settleSwarmAgent(id)
  runSwarmCommand('off')
})

assert(checks > 0, `unknown case: ${only}`)
console.log(`${checks} one-name cases passed`)

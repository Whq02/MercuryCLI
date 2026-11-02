import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import { boardSeatName, type BoardPrincipal, type BoardStore } from '../../src/services/crewBoard/contracts.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'captains-'))
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
async function world(name: string, run: (board: BoardStore, main: BoardPrincipal, seat: (id: string, team?: string, name?: string) => BoardPrincipal, path: string) => void | Promise<void>): Promise<void> {
  const path = join(home, `${name}.sqlite`)
  let now = 0
  const board = open(path, name, undefined, () => now += 15000)
  const seat = (id: string, team?: string, display = id): BoardPrincipal => ({ author: { sessionId: name, agentId: id, executionId: 'run' }, name: display, ...(team ? { team } : {}) })
  const main = seat('main')
  board.enroll(main)
  try { await run(board, main, seat, path) } finally { board.close() }
}

await check('appointment', () => world('appointment', (board, main, seat, path) => {
  const alpha = seat('alpha', 'engine', 'Alpha'), beta = seat('beta', 'engine', 'Beta'), other = seat('other', 'view')
  for (const p of [alpha, beta, other]) board.enroll(p)
  assert.equal(board.assignCaptain(alpha, 'engine', 'Alpha').ok, false)
  assert.equal(board.assignCaptain(main, 'engine', 'other').ok, false)
  assert.equal(board.assignCaptain(main, 'engine', 'main').ok, false)
  assert.equal(board.assignCaptain(main, 'engine', 'missing').ok, false)
  assert.equal(board.captain('engine'), undefined)
  assert.equal(board.assignCaptain(main, 'ENGINE', 'aLpHa').ok, true)
  assert.equal(board.captain('engine')?.agent, 'alpha')
  assert.equal(boardSeatName(board.captain('engine')!), 'captain Alpha')
  const original = board.post(alpha, { clientOpId: 'old-role', kind: 'result', text: 'The original captain result.' })
  assert(original.ok)
  assert.equal(board.assignTeam(main, 'alpha', 'view').ok, false)
  assert.equal(board.assignCaptain(main, 'engine', 'beta').ok, true)
  assert.equal(board.seats().filter(p => p.team === 'engine' && p.captain).length, 1)
  assert.equal(board.seats().find(p => p.agent === 'alpha')?.captain, undefined)
  assert.equal(board.assignTeam(main, 'alpha', 'view').ok, true)
  const old = board.view().events.find(event => event.eventId === original.eventId)!
  assert.equal(old.captain, true)
  assert.equal(old.team, 'engine')
  const packet = board.boundary(other, new Set())!
  assert(packet.text.includes('captain Beta'))
  board.presented(other, packet.eventIds, 'roster-arrived')
  assert.equal(board.boundary(other, new Set()), null)
  const reader = open(path, 'appointment', undefined, Date.now, true)
  try { assert.equal(reader.captain('ENGINE')?.agent, 'beta') } finally { reader.close() }
}))

await check('launch-reservation', () => world('launch-reservation', (board, main, seat) => {
  const captain = seat('captain', 'engine', 'Captain')
  assert.throws(() => board.reserveEnrollment(main, { agent: 'bad', name: 'Bad', captain: true }), /name and team/)
  board.reserveEnrollment(main, { agent: 'captain', name: 'Captain', team: 'engine', captain: true })
  assert.equal(board.captain('engine'), undefined)
  assert(!board.member('captain'))
  board.enroll(captain)
  board.cancelEnrollment(main, 'captain')
  assert.equal(board.captain('engine')?.agent, 'captain')
  for (let i = 0; i < 5; i++) board.enroll(seat(`member-${i}`, 'ENGINE'))
  board.settle(captain)
  board.enroll({ ...captain, author: { ...captain.author, executionId: 'resumed' } })
  assert.equal(board.seats().filter(p => p.team === 'engine').length, 6)
  assert.equal(board.captain('engine')?.agent, 'captain')
  assert.throws(() => board.reserveEnrollment(seat('member-0', 'engine'), { agent: 'self', name: 'Self', team: 'engine', captain: true }), /Only the lead/)
  assert.throws(() => board.enroll(seat('owner', 'engine')), /reserved/)
  assert.throws(() => board.enroll(seat('fake-owner', 'engine', 'OwNeR')), /reserved/)
}))

await check('fifth-seat', () => world('fifth-seat', (board, main, seat) => {
  for (let i = 0; i < 4; i++) board.enroll(seat(`member-${i}`, 'engine'))
  board.settle(seat('member-0', 'engine'))
  assert.throws(() => board.enroll(seat('fifth', 'engine')), /captain/)
  assert(!board.member('fifth'))
  assert.throws(() => board.reserveEnrollment(main, { agent: 'fifth', name: 'Fifth', team: 'engine' }), /captain/)
  board.enroll(seat('outside', 'view'))
  assert.equal(board.assignTeam(main, 'outside', 'engine').ok, false)
  assert.equal(board.seats().find(p => p.agent === 'outside')?.team, 'view')
  board.reserveEnrollment(main, { agent: 'failed', name: 'Failed', team: 'engine', captain: true })
  assert.equal(board.captain('engine'), undefined)
  assert.throws(() => board.reserveEnrollment(main, { agent: 'sixth', name: 'Sixth', team: 'engine' }), /captain/)
  board.cancelEnrollment(main, 'failed')
  assert(!board.member('failed'))
  board.reserveEnrollment(main, { agent: 'fifth', name: 'Fifth', team: 'engine', captain: true })
  board.enroll(seat('fifth', 'engine', 'Fifth'))
  assert.equal(board.captain('engine')?.agent, 'fifth')
  assert.equal(board.assignTeam(main, 'outside', 'engine').ok, true)
}))

await check('concurrent-reservations', () => world('concurrent-reservations', async (board, main, seat, path) => {
  for (let i = 0; i < 3; i++) board.enroll(seat(`member-${i}`, 'engine'))
  const reserve = (id: string): Promise<{ ok: boolean; reason?: string; id: string }> => new Promise((resolve, reject) => {
    const source = `import { open } from ${JSON.stringify(new URL('../../src/services/crewBoard/store.ts', import.meta.url).href)}; const board = open(${JSON.stringify(path)}, 'concurrent-reservations'); let result; try { board.reserveEnrollment(${JSON.stringify(main)}, {agent:${JSON.stringify(id)},name:${JSON.stringify(id)},team:'engine'}); result={ok:true,id:${JSON.stringify(id)}}; } catch(error) { result={ok:false,id:${JSON.stringify(id)},reason:String(error)} } finally { board.close() } console.log(JSON.stringify(result))`
    const child = spawn(process.execPath, ['-e', source], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += String(value) })
    child.stderr.on('data', value => { stderr += String(value) })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error(`reservation process exited ${code}: ${stderr}`))
      else { try { resolve(JSON.parse(stdout.trim())) } catch (error) { reject(error) } }
    })
  })
  const results = await Promise.all([reserve('fourth-a'), reserve('fourth-b')])
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results))
  assert(results.find(result => !result.ok)?.reason?.includes('captain'))
  board.cancelEnrollment(main, results.find(result => result.ok)!.id)
  board.reserveEnrollment(main, { agent: 'replacement-fourth', name: 'Fourth', team: 'engine' })
  board.enroll(seat('replacement-fourth', 'engine'))
  assert.equal(board.seats().filter(p => p.team === 'engine').length, 4)
}))

await check('schema-and-brief', async () => {
  const boot = await import('../../src/bootstrap/state.ts')
  boot.setOriginalCwd(home); boot.setCwdState(home); boot.setProjectRoot(home)
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const seam = await import('../../src/services/crewBoard/seam.ts')
  const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
  const { inputSchema } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const launch = { description: 'Check the fields', prompt: 'Read the fields', name: 'Captain', team: 'engine', captain: true, model: 'fixture-model', effort: 'high', isolation: 'worktree' }
  const parsed = inputSchema().safeParse(launch)
  assert(parsed.success)
  assert.equal(parsed.data.model, launch.model)
  assert.equal(parsed.data.effort, launch.effort)
  assert.equal(parsed.data.isolation, launch.isolation)
  for (const patch of [{ name: undefined }, { name: ' ' }, { team: undefined }, { captain: 'true' }]) assert(!inputSchema().safeParse({ ...launch, ...patch }).success)
  assert(inputSchema().safeParse({ description: 'A plain seat', prompt: 'Read', captain: false }).success)
  assert.equal(seam.swarmSessionEnabled(), true)
  runSwarmCommand('off')
  assert.throws(() => seam.reserveSwarmLaunch('off', launch), /swarm enrollment/)
  updateSettingsForSource('userSettings', { swarm: { enabled: true } })
  runSwarmCommand('on')
  assert.throws(() => seam.reserveSwarmLaunch('peer-launch', launch, 'a-peer'), /Only the lead/)
  const release = seam.reserveSwarmLaunch('captain', launch)
  assert(await seam.latchSwarmAgent('captain', 'Captain', false, false, 'engine'))
  release(); release()
  assert(await seam.latchSwarmAgent('member', 'Member', false, false, 'engine'))
  assert(await seam.latchSwarmAgent('plain', 'Plain'))
  const wait = 'You may park with a declared wait; the board wakes you on it, and the lead can always wake you.'
  const owner = "The owner's board posts outrank the lead's."
  for (const id of ['captain', 'member', 'plain']) {
    const brief = seam.swarmBrief(id)!
    assert.equal(brief.split(wait).length, 2)
    assert.equal(brief.split(owner).length, 2)
  }
  assert(seam.swarmBrief('captain')!.includes('You are captain of engine, with a standing wait on its traffic.'))
  assert(seam.swarmBrief('member')!.includes("Captain is your team's captain."))
  const source = readFileSync(new URL('../../src/tools/AgentTool/AgentTool.tsx', import.meta.url), 'utf8')
  const admission = source.indexOf('const releaseEnrollment = reserveSwarmLaunch(')
  assert(admission >= 0 && admission < source.indexOf('await createAgentWorktree(') && admission < source.indexOf('runAgent({'))
  assert(source.includes('.finally(releaseEnrollment)') && /finally\s*\{\s*if \(!backgroundOwnsEnrollment\) releaseEnrollment\(\)/.test(source))
  const prompt = readFileSync(new URL('../../src/tools/AgentTool/prompt.ts', import.meta.url), 'utf8')
  assert(prompt.includes('For a planned team of five or more, launch its named captain first'))
  assert(prompt.includes('For a smaller team, appoint one only when the owner asks or a seat asks on the board and you agree.'))
  assert.equal(prompt.split('A seat never self-appoints;').length, 2)
  seam.swarmStore()?.close()
})

await check('unassigned-fifth', () => world('unassigned-fifth', (board, _main, seat) => {
  for (let i = 0; i < 4; i++) board.enroll(seat(`member-${i}`, 'engine'))
  board.enroll(seat('unassigned'))
  assert.throws(() => board.enroll(seat('unassigned', 'engine')), /captain/)
  assert.equal(board.seats().find(p => p.agent === 'unassigned')?.team, undefined)
}))

await check('new-lead-execution', () => world('new-lead-execution', (board, main, seat, path) => {
  for (let i = 0; i < 3; i++) board.enroll(seat(`member-${i}`, 'engine'))
  board.reserveEnrollment(main, { agent: 'interrupted', name: 'Interrupted', team: 'engine' })
  const reopened = open(path, 'new-lead-execution')
  try {
    reopened.enroll(main)
    assert.throws(() => reopened.reserveEnrollment(main, { agent: 'too-early', name: 'Too early', team: 'engine' }), /captain/)
    const resumed = { ...main, author: { ...main.author, executionId: 'new-run' } }
    reopened.enroll(resumed)
    reopened.reserveEnrollment(resumed, { agent: 'new-fourth', name: 'New fourth', team: 'engine' })
    reopened.enroll(seat('new-fourth', 'engine'))
    assert.equal(reopened.seats().filter(p => p.team === 'engine').length, 4)
  } finally { reopened.close() }
}))

await check('unicode-labels', () => world('unicode-labels', (board, main, seat, path) => {
  const members = [seat('a', 'Équipe'), seat('b', 'Équipe'), seat('c', 'équipe'), seat('d', 'équipe')]
  for (const principal of members) board.enroll(principal)
  assert.deepEqual(board.seats().filter(row => row.agent !== 'main').map(row => row.team), Array(4).fill('Équipe'))
  const post = board.postOwner(main, { clientOpId: 'unicode-address', channel: 'team', target: 'équipe', text: 'Reach every member.' })
  assert(post.ok)
  assert.deepEqual([...post.recipients].sort(), ['a', 'b', 'c', 'd', 'main'])
  assert.deepEqual(post.channel, { kind: 'team', target: 'Équipe' })
  assert.throws(() => board.enroll(seat('e', 'ÉQUIPE')), /captain/)
  assert.throws(() => board.reserveEnrollment(main, { agent: 'e', name: 'E', team: 'équipe' }), /captain/)
  const outsider = seat('outside')
  board.enroll(outsider)
  assert.equal(board.assignTeam(main, 'outside', 'équipe').ok, false)
  assert.equal(board.assignCaptain(main, 'équipe', 'b').ok, true)
  assert.equal(board.captain('ÉQUIPE')?.agent, 'b')
  assert.equal(board.assignTeam(main, 'b', 'équipe').ok, true)
  assert.equal(board.assignTeam(main, 'b', 'Other').ok, false)
  const directed = board.postOwner(main, { clientOpId: 'unicode-captain', channel: 'team', target: 'ÉQUIPE', text: 'Reach the captain.' })
  assert(directed.ok)
  assert.deepEqual([...directed.recipients].sort(), ['b', 'main'])
  board.enroll(seat('e', 'équipe'))
  assert.equal(board.assignCaptain(main, 'ÉQUIPE', 'c').ok, true)
  assert.equal(board.seats().filter(row => row.captain).length, 1)
  board.read(outsider, { team: 'équipe', watch: true })
  const finding = board.post(members[0]!, { clientOpId: 'unicode-finding', kind: 'result', text: 'The label has one identity.', to: ['équipe'] })
  assert(finding.ok)
  assert.deepEqual([...board.view().events.find(row => row.eventId === finding.eventId)!.mentions].sort(), ['a', 'b', 'c', 'd', 'e'])
  assert(board.boundary(outsider, new Set())?.eventIds.includes(finding.eventId))
  assert(board.read(outsider, { since: 0, team: 'équipe' }).events.some(row => row.eventId === finding.eventId))
  assert(board.view(undefined, undefined, 'ÉQUIPE').events.some(row => row.eventId === finding.eventId))
  const reopened = open(path, 'unicode-labels', undefined, Date.now, true)
  try {
    assert.equal(reopened.captain('équipe')?.agent, 'c')
    assert.deepEqual(reopened.view().teams, ['Équipe'])
  } finally { reopened.close() }
}))

await check('unicode-reservations', () => world('unicode-reservations', (board, main, seat, path) => {
  board.reserveEnrollment(main, { agent: 'reserved', name: 'Reserved', team: 'Équipe' })
  for (const id of ['a', 'b', 'c']) board.enroll(seat(id, 'équipe'))
  assert.throws(() => board.reserveEnrollment(main, { agent: 'fifth', name: 'Fifth', team: 'ÉQUIPE' }), /captain/)
  board.enroll(seat('reserved', 'équipe', 'Reserved'))
  assert.deepEqual(board.seats().filter(row => row.agent !== 'main').map(row => row.team), Array(4).fill('Équipe'))
  board.settle(seat('a', 'ÉQUIPE'))
  board.enroll({ ...seat('a', 'équipe'), author: { ...seat('a').author, executionId: 'resumed' } })
  assert.equal(board.seats().length, 5)
  const reader = open(path, 'unicode-reservations')
  try {
    assert.throws(() => reader.reserveEnrollment(main, { agent: 'fifth', name: 'Fifth', team: 'équipe' }), /captain/)
    reader.reserveEnrollment(main, { agent: 'captain', name: 'Captain', team: 'ÉQUIPE', captain: true })
    reader.enroll(seat('captain', 'équipe', 'Captain'))
    assert.equal(board.captain('équipe')?.agent, 'captain')
    assert.equal(board.captain('ÉQUIPE')?.team, 'Équipe')
  } finally { reader.close() }
}))

await check('unicode-stored', () => world('unicode-stored', async (board, main, seat, path) => {
  for (const id of ['a', 'b', 'c']) board.enroll(seat(id, 'Équipe'))
  const { Database } = await import('bun:sqlite')
  const legacy = new Database(path)
  try {
    legacy.prepare("UPDATE interests SET value = 'équipe' WHERE agent IN ('b', 'c') AND kind = 'membership'").run()
    legacy.prepare('INSERT INTO enrollments (agent, name, team, captain) VALUES (?, ?, ?, ?)').run('reserved', 'Reserved', 'équipe', 0)
    assert.throws(() => board.reserveEnrollment(main, { agent: 'fifth', name: 'Fifth', team: 'ÉQUIPE' }), /captain/)
    board.enroll(seat('reserved', 'équipe', 'Reserved'))
    assert.deepEqual(board.seats().filter(row => row.agent !== 'main').map(row => row.team), Array(4).fill('Équipe'))
    const addressed = board.postOwner(main, { clientOpId: 'stored-members', channel: 'team', target: 'équipe', text: 'One stored identity.' })
    assert(addressed.ok)
    assert.deepEqual([...addressed.recipients].sort(), ['a', 'b', 'c', 'main', 'reserved'])
    assert.throws(() => board.enroll(seat('fifth', 'équipe')), /captain/)
    assert(board.assignCaptain(main, 'équipe', 'a').ok)
    legacy.prepare("UPDATE captains SET team = 'équipe' WHERE agent = 'a'").run()
    assert.equal(board.captain('ÉQUIPE')?.agent, 'a')
    assert(board.assignCaptain(main, 'ÉQUIPE', 'b').ok)
    assert.deepEqual(legacy.prepare('SELECT team, agent FROM captains').all(), [{ team: 'Équipe', agent: 'b' }])
    const old = board.post(seat('a'), { clientOpId: 'stored-post', kind: 'result', text: 'Earlier spelling.' })
    assert(old.ok)
    legacy.prepare("UPDATE events SET record = json_set(record, '$.team', 'équipe') WHERE id = ?").run(old.eventId)
    const fresh = board.post(seat('c'), { clientOpId: 'canonical-post', kind: 'result', text: 'Current spelling.' })
    assert(fresh.ok)
    assert.deepEqual(board.view(undefined, undefined, 'ÉQUIPE').events.map(event => event.eventId), [old.eventId, fresh.eventId])
    assert.deepEqual(board.read(main, { since: 0, team: 'équipe' }).events.filter(event => !('truncated' in event) && event.kind === 'result').map(event => event.eventId), [old.eventId, fresh.eventId])
    assert.deepEqual(board.view().teams, ['Équipe'])
    const reader = open(path, 'unicode-stored', undefined, Date.now, true)
    try {
      assert.equal(reader.captain('équipe')?.agent, 'b')
      assert(reader.seats().filter(row => row.agent !== 'main').every(row => row.team === 'Équipe'))
    } finally { reader.close() }
  } finally { legacy.close() }
}))

assert(checks > 0, `unknown case: ${only}`)
console.log(`${checks} captain cases passed`)

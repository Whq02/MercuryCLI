#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import {
  bootLead,
  closeWorld,
  crewMessagesTo,
  crewStoreFile,
  LEAD_GATE,
  LEAD_MODEL,
  makeTally,
  makeWorld,
  readJson,
  record,
  sleep,
  toolResultOf,
  treeOf,
  TURN_MS,
} from './team-world.ts'

const scratchTeams = mkdtempSync(join(tmpdir(), 'crew-from-birth-teams-'))
process.env.MERCURY_TEAMS_DIR = scratchTeams
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'crew-from-birth-home-'))

const tally = makeTally('prove-crew-from-birth')
const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const FIRST = 'FIRST-TURN'
const AFTER = 'AFTER-RESUME'
const SPAWN_ID = 'toolu_birth_spawn'
const NOTE_ID = 'toolu_birth_note'
const BRIEF_ID = 'toolu_birth_brief'
const BRIEF_AGAIN_ID = 'toolu_birth_brief_again'
const GAMMA_ID = 'toolu_birth_gamma'

tally.section('§0 the birth module: a crew is named by its session and founded on the first join')
type BirthModule = {
  sessionCrewName: (sessionId: string) => string
  bornCrewContext: (sessionId: string, cwd: string) => { teamName: string; teamFilePath: string; leadAgentId: string; teammates: Record<string, unknown> }
  bornCrewRoster: (sessionId: string, cwd: string) => { name: string; leadSessionId?: string; leadAgentId: string; members: Array<{ name: string; agentId: string; cwd: string }> }
}
let birth: BirthModule | null = null
try {
  birth = (await import('../../src/utils/crew/crewBirth.ts')) as unknown as BirthModule
} catch (error) {
  tally.check('src/utils/crew/crewBirth.ts exists (the one owner of the session crew)', false, error instanceof Error ? error.message : String(error))
}
if (birth !== null) {
  const sid = randomUUID()
  const name = birth.sessionCrewName(sid)
  tally.check('the crew is named by its session', name === sid, name)
  const context = birth.bornCrewContext(sid, '/tmp/somewhere')
  tally.check('the born context names the crew, its roster path and the lead agent id', context.teamName === sid && context.leadAgentId === `team-lead@${sid}` && context.teamFilePath.endsWith(join(sid, 'config.json')), JSON.stringify(context))
  tally.check('the born context lists no crewmate yet (the lead is not its own crewmate)', Object.keys(context.teammates).length === 0, JSON.stringify(context.teammates))
  const roster = birth.bornCrewRoster(sid, '/tmp/somewhere')
  tally.check('the founding roster carries the lead alone, led by this session', roster.name === sid && roster.leadSessionId === sid && roster.leadAgentId === `team-lead@${sid}` && roster.members.length === 1 && roster.members[0]!.name === 'team-lead' && roster.members[0]!.cwd === '/tmp/somewhere', JSON.stringify(roster))
  const state = await import('../../src/bootstrap/state.ts')
  const ownSid = String(state.getSessionId())
  const helpers = await import('../../src/utils/swarm/teamHelpers.ts')
  const ownCrew = birth.sessionCrewName(ownSid)
  const ownPath = helpers.getTeamFilePath(ownCrew)
  tally.check('before the first join the crew has no roster file (nothing is written at birth)', !existsSync(ownPath), ownPath)
  let joined = true
  let joinError = ''
  try {
    await helpers.appendTeamMember(ownCrew, { agentId: `alpha@${ownCrew}`, name: 'alpha', model: 'claude-opus-4-6', joinedAt: Date.now(), tmuxPaneId: 'in-process', cwd: '/tmp/somewhere', subscriptions: [] } as never)
  } catch (error) {
    joined = false
    joinError = error instanceof Error ? error.message : String(error)
  }
  tally.check('the first join founds the crew roster instead of demanding a create step', joined, joinError)
  const founded = helpers.readTeamFile(ownCrew)
  tally.check('the founded roster lists the lead and the crewmate, with the model as named', founded !== null && founded.members.map(m => m.name).join(',') === 'team-lead,alpha' && founded.members[1]!.model === 'claude-opus-4-6' && founded.leadSessionId === ownSid, JSON.stringify(founded?.members.map(m => [m.name, m.model])))
  let foreign = ''
  try {
    await helpers.appendTeamMember('nonesuch-team', { agentId: 'x@nonesuch-team', name: 'x', joinedAt: Date.now(), tmuxPaneId: '', cwd: '/tmp', subscriptions: [] } as never)
  } catch (error) {
    foreign = error instanceof Error ? error.message : String(error)
  }
  tally.check('a join into a team that is not this session\'s crew still refuses, and the words name no create tool', foreign.includes('does not exist') && !/create the team/i.test(foreign), foreign)
}

tally.section('§1 a fresh session: the first spawn, message and brief find the crew — no create call')
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const seat = (name: string, word: string): ScriptedTurn =>
  ({ kind: 'text', text: `${name} is idle.`, model: SEAT_MODEL, whenModel: SEAT_GATE, whenBody: word }) as ScriptedTurn
const spawn = (id: string, name: string, word: string): Record<string, unknown> => ({
  kind: 'tool_use',
  id,
  name: 'Agent',
  input: { name, team_name: 'crew', model: SEAT_MODEL, subagent_type: 'mercury-general', description: `the ${name} seat`, prompt: `${word}: reply once.` },
})
const script: ScriptedTurn[] = [
  lead(spawn(SPAWN_ID, 'scout', 'SCOUT-WORK'), FIRST),
  lead({ kind: 'tool_use', id: NOTE_ID, name: 'SendMessage', input: { to: 'scout', message: 'NOTE-FOR-SCOUT: keep this.', summary: 'a note' } }, FIRST),
  lead({ kind: 'tool_use', id: BRIEF_ID, name: 'TeamBrief', input: {} }, FIRST),
  lead({ kind: 'text', text: 'CREW-STARTED' }, FIRST),
  seat('scout', 'SCOUT-WORK'),
  lead({ kind: 'tool_use', id: BRIEF_AGAIN_ID, name: 'TeamBrief', input: {} }, AFTER),
  lead(spawn(GAMMA_ID, 'gamma', 'GAMMA-WORK'), AFTER),
  lead({ kind: 'text', text: 'RESUME-DONE' }, AFTER),
  seat('gamma', 'GAMMA-WORK'),
]
const world = await makeWorld('crew-from-birth', script)
const sessionId = randomUUID()
const crewDir = join(world.teams, sessionId)
const configPath = join(crewDir, 'config.json')
type Roster = { name: string; leadSessionId?: string; leadAgentId: string; members: Array<{ name: string; model?: string }> }
type InboxRow = { from: string; text: string }
const inbox = (name: string): InboxRow[] => crewMessagesTo(world, sessionId, name)
const idleNotices = (): number => inbox('team-lead').filter(row => row.text.includes('idle_notification')).length
const tools = ['Agent', 'SendMessage', 'TeamBrief']
const transcriptsOf = (): string[] => treeOf(join(world.config, 'projects')).filter(path => path.endsWith(`${sessionId}.jsonl`))
const toolUseNamesOf = (jsonl: string): string[] => {
  const names: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const block = node as { type?: string; kind?: string; name?: string }
    if ((block.type === 'tool_use' || block.kind === 'tool-use') && typeof block.name === 'string') names.push(block.name)
    for (const value of Object.values(node)) walk(value)
  }
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      walk(JSON.parse(line))
    } catch {
      continue
    }
  }
  return names
}
const first = bootLead(world, ['--session-id', sessionId], tools)
try {
  first.submit(`${FIRST}: spawn scout, leave it a note, read the brief.`)
  await first.waitFor('the first session never settled', () => first.stdout().includes('CREW-STARTED'), TURN_MS)
  const spawned = toolResultOf(world, SPAWN_ID)
  record('first-spawn-result.txt', `${spawned?.text ?? ''}\nis_error=${String(spawned?.isError)}\n`)
  tally.check('the first spawn lands as a crewmate with no create step before it', spawned !== null && spawned.isError === false && /teammate_spawned|Teammate spawned/i.test(spawned.text), `${spawned?.text.slice(0, 220) ?? '(no result)'} is_error=${String(spawned?.isError)}`)
  const started = first.frames.find(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_teammate')
  const seatRequests = (): number => world.fixture.messageRequests().filter(request => (request.body as { model?: string } | null)?.model === SEAT_MODEL).length
  tally.check('the crewmate is on the roster and ran its first turn (an in-process crewmate task started, a request on its model)', started !== undefined && seatRequests() >= 1, `${JSON.stringify(first.frames.filter(frame => frame.subtype === 'task_started').map(frame => frame.task_type))} seat requests=${seatRequests()}`)
  const roster = readJson<Roster>(configPath)
  tally.check('the crew roster on disk is the session\'s: led by this session, the lead and scout on it, the model as named', roster !== null && roster.name === sessionId && roster.leadSessionId === sessionId && roster.leadAgentId === `team-lead@${sessionId}` && roster.members.map(m => m.name).join(',') === 'team-lead,scout' && roster.members[1]!.model === SEAT_MODEL, JSON.stringify(roster?.members.map(m => [m.name, m.model]) ?? treeOf(world.teams)))
  const note = toolResultOf(world, NOTE_ID)
  tally.check('the first message to the crewmate is delivered to its inbox', note !== null && note.isError === false && inbox('scout').some(row => row.text.includes('NOTE-FOR-SCOUT')), `${note?.text.slice(0, 200) ?? '(no result)'} inbox=${JSON.stringify(inbox('scout').map(row => row.text.slice(0, 40)))}`)
  const brief = toolResultOf(world, BRIEF_ID)
  record('first-brief.txt', `${brief?.text ?? ''}\n`)
  tally.check('the first brief names the session\'s crew and lists scout', brief !== null && new RegExp(`# (Team|Crew): ${sessionId}`).test(brief.text) && /- scout\b/.test(brief.text), brief?.text.slice(0, 240) ?? '(no result)')
  const until = Date.now() + TURN_MS / 3
  while (idleNotices() < 1 && Date.now() < until) await sleep(50)
  tally.check('the crewmate\'s idle notice reaches the lead on the crew\'s own store', idleNotices() >= 1, `${idleNotices()} notice(s) on ${crewStoreFile(world, sessionId)}`)
  const transcript = transcriptsOf()
  const toolUses = transcript.length === 1 ? toolUseNamesOf(readFileSync(join(world.config, 'projects', transcript[0]!), 'utf8')) : []
  tally.check('the transcript carries the spawn and no TeamCreate row', transcript.length === 1 && toolUses.includes('Agent') && !toolUses.includes('TeamCreate'), `${JSON.stringify(transcript)} tool_use rows=${JSON.stringify(toolUses)}`)
  const code = await first.terminate()
  tally.check('the first session exited on the graceful signal', code !== null, `exit ${String(code)}`)
  record('lead-stderr-first.txt', first.stderr())
} catch (error) {
  tally.check('the first session ran to its exit', false, error instanceof Error ? error.message : String(error))
  await first.terminate()
}

tally.section('§2 the resumed session finds the same crew, and a new crewmate joins it')
const second = bootLead(world, ['--resume', sessionId], tools)
try {
  second.submit(`${AFTER}: read the brief again, add gamma.`)
  await second.waitFor('the resumed session never settled', () => second.stdout().includes('RESUME-DONE'), TURN_MS)
  const brief = toolResultOf(world, BRIEF_AGAIN_ID)
  record('resumed-brief.txt', `${brief?.text ?? ''}\n`)
  tally.check('the resumed brief names the same crew and still lists scout', brief !== null && new RegExp(`# (Team|Crew): ${sessionId}`).test(brief.text) && /- scout\b/.test(brief.text), brief?.text.slice(0, 240) ?? '(no result)')
  const gamma = toolResultOf(world, GAMMA_ID)
  record('resumed-gamma-result.txt', `${gamma?.text ?? ''}\nis_error=${String(gamma?.isError)}\n`)
  tally.check('a new crewmate joins the surviving crew', gamma !== null && gamma.isError === false && !/does not exist/.test(gamma.text), `${gamma?.text.slice(0, 200) ?? '(no result)'} is_error=${String(gamma?.isError)}`)
  const roster = readJson<Roster>(configPath)
  tally.check('the roster on disk names the lead, scout and gamma', ['team-lead', 'scout', 'gamma'].every(name => (roster?.members ?? []).some(m => m.name === name)), JSON.stringify(roster?.members.map(m => m.name)))
  record('lead-stderr-second.txt', second.stderr())
} catch (error) {
  tally.check('the resumed session ran', false, error instanceof Error ? error.message : String(error))
} finally {
  await second.terminate()
}

tally.section('§3 a session that spawns nothing still closes on the end of its input')
const plainWorld = await makeWorld('crew-from-birth-plain', [lead({ kind: 'text', text: 'PLAIN-DONE' }, 'PLAIN')])
const plain = bootLead(plainWorld, [], ['Agent'])
try {
  plain.submit('PLAIN: say the word.')
  await plain.waitFor('the plain session never answered', () => plain.stdout().includes('PLAIN-DONE'), TURN_MS)
  const code = await plain.end()
  tally.check('the input end closes the session (no crew shutdown prompt for a crew with no crewmates)', code === 0, `exit ${String(code)}; stdout tail: ${plain.stdout().slice(-300)}`)
  tally.check('no second turn was asked of the model', plainWorld.fixture.messageRequests().length === 1, `${plainWorld.fixture.messageRequests().length} request(s)`)
} catch (error) {
  tally.check('the plain session ran', false, error instanceof Error ? error.message : String(error))
  await plain.terminate()
} finally {
  await closeWorld(plainWorld)
  await closeWorld(world)
}
tally.finish()

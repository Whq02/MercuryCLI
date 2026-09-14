#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import {
  bootLead,
  closeWorld,
  LEAD_GATE,
  LEAD_MODEL,
  makeTally,
  makeWorld,
  readJson,
  record,
  sleep,
  toolResultOf,
  treeOf,
} from './team-world.ts'

const TEAM = 'lasting'
const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const FIRST = 'START-TEAM'
const AFTER = 'AFTER-RESTART'
const BRIEF_ID = 'toolu_lasting_brief'
const CREATE_AGAIN_ID = 'toolu_lasting_create_again'
const GAMMA_ID = 'toolu_lasting_gamma'

const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const seat = (name: string, word: string): ScriptedTurn[] => [
  { kind: 'text', text: `${name} is idle.`, model: SEAT_MODEL, whenModel: SEAT_GATE, whenBody: word } as ScriptedTurn,
]
const spawn = (id: string, name: string, word: string): Record<string, unknown> => ({
  kind: 'tool_use',
  id,
  name: 'Agent',
  input: { name, team_name: TEAM, model: SEAT_MODEL, subagent_type: 'mercury-general', description: `the ${name} seat`, prompt: `${word}: reply once.` },
})

const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', id: 'toolu_lasting_team', name: 'TeamCreate', input: { team_name: TEAM, description: 'the team that lasts' } }, FIRST),
  lead(spawn('toolu_lasting_alpha', 'alpha', 'ALPHA-WORK'), FIRST),
  lead(spawn('toolu_lasting_beta', 'beta', 'BETA-WORK'), FIRST),
  lead({ kind: 'tool_use', id: 'toolu_lasting_note', name: 'SendMessage', input: { to: 'alpha', message: 'NOTE-FOR-ALPHA: keep this.', summary: 'a note' } }, FIRST),
  lead({ kind: 'text', text: 'TEAM-STARTED' }, FIRST),
  ...seat('alpha', 'ALPHA-WORK'),
  ...seat('beta', 'BETA-WORK'),
  lead({ kind: 'tool_use', id: BRIEF_ID, name: 'TeamBrief', input: {} }, AFTER),
  lead({ kind: 'tool_use', id: CREATE_AGAIN_ID, name: 'TeamCreate', input: { team_name: TEAM, description: 'the team that lasts' } }, AFTER),
  lead(spawn(GAMMA_ID, 'gamma', 'GAMMA-WORK'), AFTER),
  lead({ kind: 'text', text: 'RESTART-DONE' }, AFTER),
  ...seat('gamma', 'GAMMA-WORK'),
]

const tally = makeTally('prove-team-survives-restart')
const world = await makeWorld('team-survives-restart', script)
const sessionId = randomUUID()
const teamDir = join(world.teams, TEAM)
const configPath = join(teamDir, 'config.json')
type Roster = { name: string; leadSessionId?: string; members: Array<{ name: string }> }
type InboxRow = { from: string; text: string }
const inbox = (name: string): InboxRow[] => readJson<InboxRow[]>(join(teamDir, 'inboxes', `${name}.json`)) ?? []
const idleNotices = (): number => inbox('team-lead').filter(row => row.text.includes('idle_notification')).length

const tools = ['Agent', 'SendMessage', 'TeamCreate', 'TeamBrief']
const first = bootLead(world, ['--session-id', sessionId], tools)
let before: string[] = []
let after: string[] = []
try {
  tally.section('a team with a config, two inboxes with rows and a lease store, then the lead exits')
  first.submit(`${FIRST}: create the team, spawn alpha and beta, leave alpha a note.`)
  await first.waitFor('the team never started', () => first.stdout().includes('TEAM-STARTED'))
  const until = Date.now() + 30_000
  while (idleNotices() < 2 && Date.now() < until) await sleep(50)
  tally.check('both seats reported idle to the lead inbox', idleNotices() >= 2, `${idleNotices()} notice(s)`)
  tally.check("alpha's inbox holds the lead's note", inbox('alpha').some(row => row.text.includes('NOTE-FOR-ALPHA')))
  const rosterBefore = readJson<Roster>(configPath)
  tally.check('the config lists the lead and both seats', (rosterBefore?.members ?? []).length === 3, JSON.stringify(rosterBefore?.members.map(m => m.name)))
  before = treeOf(teamDir)
  record('team-folder-before-exit.txt', before.join('\n') + '\n')
  record('config-before-exit.json', JSON.stringify(rosterBefore, null, 2) + '\n')
  record('inbox-team-lead-before-exit.json', JSON.stringify(inbox('team-lead'), null, 2) + '\n')
  const code = await first.terminate()
  tally.check('the lead exited on the graceful signal', code !== null, `exit ${String(code)}`)
  after = treeOf(teamDir)
  record('team-folder-after-exit.txt', after.join('\n') + '\n')
  record('lead-stderr-first.txt', first.stderr())

  tally.section('the team folder after the exit')
  tally.check('the config survives the exit', readJson<Roster>(configPath) !== null, after.join(' ') || '(folder gone)')
  tally.check("alpha's inbox survives with its rows", inbox('alpha').some(row => row.text.includes('NOTE-FOR-ALPHA')))
  tally.check("the lead's inbox survives with its rows", idleNotices() >= 2, `${idleNotices()} notice(s)`)
} catch (error) {
  tally.check('the first session ran to its exit', false, error instanceof Error ? error.message : String(error))
}

tally.section('the lead resumes: every team tool answers the same fact')
const second = bootLead(world, ['--resume', sessionId], tools)
try {
  second.submit(`${AFTER}: read the brief, create the team again, add gamma.`)
  await second.waitFor('the resumed lead never settled', () => second.stdout().includes('RESTART-DONE'))
  const brief = toolResultOf(world, BRIEF_ID)
  const createAgain = toolResultOf(world, CREATE_AGAIN_ID)
  const gamma = toolResultOf(world, GAMMA_ID)
  record('resumed-team-brief.txt', `${brief?.text ?? ''}\n`)
  record('resumed-team-create-again.txt', `${createAgain?.text ?? ''}\nis_error=${String(createAgain?.isError)}\n`)
  record('resumed-agent-gamma.txt', `${gamma?.text ?? ''}\nis_error=${String(gamma?.isError)}\n`)
  record('lead-stderr-second.txt', second.stderr())
  const briefText = brief?.text ?? ''
  tally.check('the resumed lead is still part of its team', briefText.includes(`# Team: ${TEAM}`), briefText.slice(0, 160))
  tally.check('the brief lists both seats', /- alpha\b/.test(briefText) && /- beta\b/.test(briefText), briefText.slice(0, 300))
  const createText = createAgain?.text ?? ''
  const rosterNow = readJson<Roster>(configPath)
  tally.check('a second create of the same team is refused as already existing', createAgain?.isError === true && /already exists/.test(createText), createText.slice(0, 200))
  tally.check('no create answers success for a file that is not there', !(createAgain?.isError !== true && rosterNow === null), createText.slice(0, 200))
  const gammaText = gamma?.text ?? ''
  tally.check('a new seat joins the surviving team', !/does not exist/.test(gammaText) && gamma?.isError !== true, gammaText.slice(0, 200))
  const rosterAfter = readJson<Roster>(configPath)
  tally.check('the roster on disk names the lead, alpha, beta and gamma', ['alpha', 'beta', 'gamma', 'team-lead'].every(name => (rosterAfter?.members ?? []).some(m => m.name === name)), JSON.stringify(rosterAfter?.members.map(m => m.name)))
  record('config-after-resume.json', JSON.stringify(rosterAfter, null, 2) + '\n')
} catch (error) {
  tally.check('the resumed session ran', false, error instanceof Error ? error.message : String(error))
} finally {
  await second.end()
  await closeWorld(world)
}
tally.finish()

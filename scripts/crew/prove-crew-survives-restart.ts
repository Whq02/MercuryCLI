#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import {
  bootLead,
  closeWorld,
  crewMessagesTo,
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
} from './crew-world.ts'

const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const FIRST = 'START-CREW'
const AFTER = 'AFTER-RESTART'
const BRIEF_ID = 'toolu_lasting_brief'
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
  input: { name, crew_name: 'crew', model: SEAT_MODEL, subagent_type: 'mercury-general', description: `the ${name} seat`, prompt: `${word}: reply once.` },
})

const script: ScriptedTurn[] = [
  lead(spawn('toolu_lasting_alpha', 'alpha', 'ALPHA-WORK'), FIRST),
  lead(spawn('toolu_lasting_beta', 'beta', 'BETA-WORK'), FIRST),
  lead({ kind: 'tool_use', id: 'toolu_lasting_note', name: 'SendMessage', input: { to: 'alpha', message: 'NOTE-FOR-ALPHA: keep this.', summary: 'a note' } }, FIRST),
  lead({ kind: 'text', text: 'CREW-STARTED' }, FIRST),
  ...seat('alpha', 'ALPHA-WORK'),
  ...seat('beta', 'BETA-WORK'),
  lead({ kind: 'tool_use', id: BRIEF_ID, name: 'LiveComms', input: {} }, AFTER),
  lead(spawn(GAMMA_ID, 'gamma', 'GAMMA-WORK'), AFTER),
  lead({ kind: 'text', text: 'RESTART-DONE' }, AFTER),
  ...seat('gamma', 'GAMMA-WORK'),
]

const tally = makeTally('prove-crew-survives-restart')
const world = await makeWorld('crew-survives-restart', script)
const sessionId = randomUUID()
const CREW = sessionId
const crewDir = join(world.crews, CREW)
const configPath = join(crewDir, 'config.json')
type Roster = { name: string; leadSessionId?: string; members: Array<{ name: string }> }
type InboxRow = { from: string; text: string }
const inbox = (name: string): InboxRow[] => crewMessagesTo(world, CREW, name)
const idleNotices = (): number => inbox('crew-lead').filter(row => row.text.includes('idle_notification')).length

const tools = ['Agent', 'SendMessage', 'LiveComms']
const first = bootLead(world, ['--session-id', sessionId], tools)
let before: string[] = []
let after: string[] = []
try {
  tally.section('a crew with a config, two crewmates\' rows on the crew store and a lease store, then the lead exits')
  first.submit(`${FIRST}: spawn alpha and beta, leave alpha a note.`)
  await first.waitFor('the crew never started', () => first.stdout().includes('CREW-STARTED'), TURN_MS)
  const until = Date.now() + TURN_MS / 3
  while (idleNotices() < 2 && Date.now() < until) await sleep(50)
  tally.check('both seats reported idle to the lead inbox', idleNotices() >= 2, `${idleNotices()} notice(s)`)
  tally.check("alpha's inbox holds the lead's note", inbox('alpha').some(row => row.text.includes('NOTE-FOR-ALPHA')))
  const rosterBefore = readJson<Roster>(configPath)
  tally.check('the config lists the lead and both seats', (rosterBefore?.members ?? []).length === 3, JSON.stringify(rosterBefore?.members.map(m => m.name)))
  before = treeOf(crewDir)
  record('crew-folder-before-exit.txt', before.join('\n') + '\n')
  record('config-before-exit.json', JSON.stringify(rosterBefore, null, 2) + '\n')
  record('inbox-crew-lead-before-exit.json', JSON.stringify(inbox('crew-lead'), null, 2) + '\n')
  const code = await first.terminate()
  tally.check('the lead exited on the graceful signal', code !== null, `exit ${String(code)}`)
  after = treeOf(crewDir)
  record('crew-folder-after-exit.txt', after.join('\n') + '\n')
  record('lead-stderr-first.txt', first.stderr())

  tally.section('the crew folder after the exit')
  tally.check('the config survives the exit', readJson<Roster>(configPath) !== null, after.join(' ') || '(folder gone)')
  tally.check("alpha's inbox survives with its rows", inbox('alpha').some(row => row.text.includes('NOTE-FOR-ALPHA')))
  tally.check("the lead's inbox survives with its rows", idleNotices() >= 2, `${idleNotices()} notice(s)`)
} catch (error) {
  tally.check('the first session ran to its exit', false, error instanceof Error ? error.message : String(error))
}

tally.section('the lead resumes: every crew tool answers the same fact')
const second = bootLead(world, ['--resume', sessionId], tools)
try {
  second.submit(`${AFTER}: read the brief, add gamma.`)
  await second.waitFor('the resumed lead never settled', () => second.stdout().includes('RESTART-DONE'))
  const brief = toolResultOf(world, BRIEF_ID)
  const gamma = toolResultOf(world, GAMMA_ID)
  record('resumed-crew-brief.txt', `${brief?.text ?? ''}\n`)
  record('resumed-agent-gamma.txt', `${gamma?.text ?? ''}\nis_error=${String(gamma?.isError)}\n`)
  record('lead-stderr-second.txt', second.stderr())
  const briefText = brief?.text ?? ''
  tally.check('the resumed lead is still part of its crew, and no create step was needed', briefText.includes(`# Crew: ${CREW}`), briefText.slice(0, 160))
  tally.check('the brief lists both seats', /- alpha\b/.test(briefText) && /- beta\b/.test(briefText), briefText.slice(0, 300))
  const gammaText = gamma?.text ?? ''
  tally.check('a new seat joins the surviving crew', !/does not exist/.test(gammaText) && gamma?.isError !== true, gammaText.slice(0, 200))
  const rosterAfter = readJson<Roster>(configPath)
  tally.check('no join answers success without the roster on disk: the roster names the lead, alpha, beta and gamma', gamma?.isError !== true && rosterAfter !== null && ['alpha', 'beta', 'gamma', 'crew-lead'].every(name => (rosterAfter?.members ?? []).some(m => m.name === name)), JSON.stringify(rosterAfter?.members.map(m => m.name)))
  tally.check('the resumed crew is still the session\'s own: led by it, its lead id unchanged', rosterAfter?.leadSessionId === sessionId && rosterAfter?.name === CREW, JSON.stringify({ lead: rosterAfter?.leadSessionId, name: rosterAfter?.name }))
  record('config-after-resume.json', JSON.stringify(rosterAfter, null, 2) + '\n')
} catch (error) {
  tally.check('the resumed session ran', false, error instanceof Error ? error.message : String(error))
} finally {
  await second.end()
  await closeWorld(world)
}
tally.finish()

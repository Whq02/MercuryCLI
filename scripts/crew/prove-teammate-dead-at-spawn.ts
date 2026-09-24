#!/usr/bin/env bun
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
  TURN_MS,
  userTextsOf,
} from './team-world.ts'

const TEAM = 'spawn-truth'
const SEAT = 'ghost'
const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const CAUSE = 'THE-SEAT-CANNOT-START'
const FIRST = 'START-SPAWN'
const SECOND = 'SECOND-TURN'
const SPAWN_ID = 'toolu_ghost_spawn'
const MESSAGE_ID = 'toolu_ghost_message'
const BRIEF_ID = 'toolu_ghost_brief'

const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn

const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', id: 'toolu_ghost_team', name: 'TeamCreate', input: { team_name: TEAM, description: 'the spawn-truth team' } }, FIRST),
  lead(
    {
      kind: 'tool_use',
      id: SPAWN_ID,
      name: 'Agent',
      input: { name: SEAT, team_name: TEAM, model: SEAT_MODEL, subagent_type: 'mercury-general', description: 'the ghost seat', prompt: 'GHOST-WORK: reply once.' },
    },
    FIRST,
  ),
  lead({ kind: 'text', text: 'SPAWN-REPORTED' }, FIRST),
  { kind: 'error', status: 400, errorType: 'invalid_request_error', message: CAUSE, whenModel: SEAT_GATE },
  lead({ kind: 'tool_use', id: MESSAGE_ID, name: 'SendMessage', input: { to: SEAT, message: 'MORE-WORK for the ghost.', summary: 'more work' } }, SECOND),
  lead({ kind: 'tool_use', id: BRIEF_ID, name: 'TeamBrief', input: {} }, SECOND),
  lead({ kind: 'text', text: 'LEAD-DONE' }, SECOND),
]

const tally = makeTally('prove-teammate-dead-at-spawn')
const world = await makeWorld('teammate-dead-at-spawn', script)
const session = bootLead(world, [], ['Agent', 'SendMessage', 'TeamCreate', 'TeamBrief'])
const inboxPath = join(world.teams, TEAM, 'inboxes', 'team-lead.json')
const configPath = join(world.teams, TEAM, 'config.json')
type InboxRow = { from: string; text: string; read?: boolean }
type Roster = { members: Array<{ name: string; isActive?: boolean }> }
const failedNotice = (): InboxRow | undefined =>
  (readJson<InboxRow[]>(inboxPath) ?? []).find(row => row.from === SEAT && row.text.includes('idle_notification') && row.text.includes('"failed"'))

try {
  tally.section('the lead creates the team and spawns a seat whose first dispatch fails')
  session.submit(`${FIRST}: create the team and the ghost seat.`)
  await session.waitFor('the lead never reported the spawn', () => session.stdout().includes('SPAWN-REPORTED'), TURN_MS)
  const spawnAnswer = toolResultOf(world, SPAWN_ID)
  tally.check('the Agent tool answered', spawnAnswer !== null)
  const answerText = spawnAnswer?.text ?? ''
  record('agent-tool-answer.txt', `${answerText}\nis_error=${String(spawnAnswer?.isError)}\n`)

  const until = Date.now() + TURN_MS / 3
  while (failedNotice() === undefined && Date.now() < until) await sleep(50)
  const notice = failedNotice()
  record('team-lead-inbox.json', JSON.stringify(readJson(inboxPath), null, 2) + '\n')
  tally.check('the seat wrote its failure notice to the lead inbox', notice !== undefined, JSON.stringify(readJson(inboxPath)).slice(0, 400))
  tally.check('the failure notice carries the cause', notice !== undefined && notice.text.includes(CAUSE))

  tally.section('the tool answer is the fact the notice carries')
  tally.check('the answer does not say the dead seat is running', !/is running/.test(answerText), answerText.slice(0, 200))
  tally.check('the answer is an error outcome', spawnAnswer?.isError === true)
  tally.check('the answer names the seat', answerText.includes(SEAT))
  tally.check('the answer names the cause', answerText.includes(CAUSE), answerText.slice(0, 200))

  tally.section('the roster the team view reads never shows the dead seat as running')
  const roster = readJson<Roster>(configPath)
  record('config-after-failure.json', JSON.stringify(roster, null, 2) + '\n')
  const ghostRow = roster?.members.find(m => m.name === SEAT)
  tally.check('the dead seat is not a running roster member', ghostRow === undefined || ghostRow.isActive === false, JSON.stringify(ghostRow))

  tally.section('a message to the dead seat is refused with the cause, and the brief agrees')
  session.submit(`${SECOND}: message the ghost and read the brief.`)
  await session.waitFor('the second turn never settled', () => session.stdout().includes('LEAD-DONE'))
  const message = toolResultOf(world, MESSAGE_ID)
  const brief = toolResultOf(world, BRIEF_ID)
  record('send-message-answer.txt', `${message?.text ?? ''}\nis_error=${String(message?.isError)}\n`)
  record('team-brief-answer.txt', `${brief?.text ?? ''}\n`)
  const messageText = message?.text ?? ''
  tally.check('the message was not reported delivered', !/delivered to/.test(messageText), messageText.slice(0, 200))
  tally.check('the refusal names the cause', messageText.includes(CAUSE) || /failed/.test(messageText), messageText.slice(0, 200))
  const briefText = brief?.text ?? ''
  tally.check('the brief does not list the dead seat as a live member', !new RegExp(`- ${SEAT}\\b[^\\n]*\\[(idle|busy)\\]`).test(briefText), briefText.slice(0, 300))
  record('lead-user-texts.txt', userTextsOf(world).join('\n\n=====\n\n') + '\n')
} finally {
  await session.end()
  await closeWorld(world)
}
tally.finish()

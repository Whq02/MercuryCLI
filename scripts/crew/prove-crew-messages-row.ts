#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, sleep, treeOf, TURN_MS } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const WORKER_PROMPT = 'WORKER-PROMPT'
const REPLY = 'ROW-KIND-REPLY: the worker reports while the lead runs its command.'
const LEAD_BASH = 'toolu_lead_long_command'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', whenBody: when }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: crew, model: peerModel, subagent_type: 'mercury-general', description: 'Reports while the lead works', prompt: `${WORKER_PROMPT}: wait two seconds, then report to crew-lead.` } }, FIRST),
  lead({ kind: 'tool_use', id: LEAD_BASH, name: 'Bash', input: { command: 'sleep 6', description: 'The lead\'s own long command' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-DONE' }, FIRST),
  ...Array.from({ length: 10 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 2', description: 'A short wait' } }, WORKER_PROMPT),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: REPLY, summary: 'the report' } }, WORKER_PROMPT),
  peer({ kind: 'text', text: 'WORKER-DONE' }, WORKER_PROMPT),
]
const tally = makeTally('prove-crew-messages-row')
const world = await makeWorld('crew-messages-row', script)
const session = bootLead(world, ['--mode', 'sovereign', '--session-id', sessionId], ['Agent', 'Bash', 'SendMessage'])
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
const leadRequests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === LEAD_MODEL)
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const projects = join(world.config, 'projects')
type Row = { kind?: string; attachmentType?: string; fields?: { messages?: Array<{ from: string; text: string }> }; content?: unknown }
const leadRows = (): Row[] =>
  treeOf(projects)
    .filter(path => path.endsWith(`${sessionId}.jsonl`))
    .flatMap(path =>
      readFileSync(join(projects, path), 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
          try {
            return ((JSON.parse(line) as { payload?: Row }).payload ?? {}) as Row
          } catch {
            return {}
          }
        }),
    )
const attachmentRows = (): Row[] => leadRows().filter(row => row.kind === 'attachment')
const replyRows = (): Row[] => attachmentRows().filter(row => (row.fields?.messages ?? []).some(m => m.text === REPLY))

try {
  tally.section('the lead spawns a worker and runs its own long command; the worker reports while that command runs')
  session.submit(`${FIRST}: spawn the worker, then run the long command.`)
  await session.waitFor('the lead never finished its turn', () => session.stdout().includes('LEAD-DONE'), TURN_MS)
  const boundary = leadRequests().find(request => lastUser(request).includes('ROW-KIND-REPLY'))
  record('lead-boundary-request.json', JSON.stringify(boundary?.body ?? null, null, 2))
  tally.check('the worker\'s report reaches the lead at its tool boundary, beside the command\'s result, in the crewmate-message envelope', boundary !== undefined && lastUser(boundary).includes('"tool_result"') && lastUser(boundary).includes(`crewmate_id=\\"${worker}\\"`), boundary === undefined ? String(leadRequests().length) : lastUser(boundary).slice(-300))

  tally.section('the report lands in the lead\'s chat: a row of its transcript carries the words, and no row of any transcript is written under the old kind')
  const rowLanded = await until(() => leadRows().some(row => JSON.stringify(row).includes('ROW-KIND-REPLY')), TURN_MS / 3)
  record('lead-attachment-rows.json', JSON.stringify(attachmentRows().map(row => ({ kind: row.attachmentType, fields: JSON.stringify(row.fields).slice(0, 200) })), null, 2) + '\n')
  tally.check('the lead\'s transcript carries the report in a row of its own', rowLanded, JSON.stringify(attachmentRows().map(row => row.attachmentType)))
  tally.check('no row of the lead\'s transcript is written under the old kind teammate_mailbox', !attachmentRows().some(row => row.attachmentType === 'teammate_mailbox'), JSON.stringify(attachmentRows().map(row => row.attachmentType)))
  tally.check('no row of the lead\'s transcript carries the crew kind either — the boundary road delivers as a queued command, the kind is the transcript reader\'s (an old row) and the attachment road\'s (folded dead on this tree)', !attachmentRows().some(row => row.attachmentType === 'crew_messages'), JSON.stringify(attachmentRows().map(row => row.attachmentType)))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()

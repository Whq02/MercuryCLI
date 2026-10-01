#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, sleep, toolResultOf, treeOf, TURN_MS, type Frame } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const workerAgentId = `${worker}@${crew}`
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const STOP_NOTICE = 'stopped from the crew view'
const SEND_1 = 'toolu_send_after_stop'
const MESSAGE_1 = 'CONTINUE-NOW-1: run pwd again.'
const NOTE_R = 'CONTINUE-NOW-R: run pwd once more.'
const PWD = 'pwd -P'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when?: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', ...(when !== undefined ? { whenBody: when } : {}) }) as ScriptedTurn
const tally = makeTally('prove-crewmate-resume-keeps-folder')
const work = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'crewmate-place-'))
const place = realpathSync(work)
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: crew, cwd: work, model: peerModel, subagent_type: 'mercury-general', description: 'Keep the place', prompt: 'Run pwd and report the folder you work in.' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead({ kind: 'tool_use', id: SEND_1, name: 'SendMessage', input: { to: worker, message: MESSAGE_1, summary: 'pwd again' } }, STOP_NOTICE),
  lead({ kind: 'text', text: 'LEAD-SENT-1' }, STOP_NOTICE),
  ...Array.from({ length: 12 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: PWD, description: 'Name the folder' } }, NOTE_R),
  peer({ kind: 'text', text: 'PLACE-NAMED-R' }, NOTE_R),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: PWD, description: 'Name the folder' } }, MESSAGE_1),
  peer({ kind: 'paced', deltas: ['STILL-WORKING-1', '.', '.', '.', '.', '.'], gapMs: 5000 }, MESSAGE_1),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: PWD, description: 'Name the folder' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
]
const world = await makeWorld('crewmate-resume-keeps-folder', script)
const session = bootLead(world, ['--mode', 'sovereign', '--session-id', sessionId], ['Agent', 'Bash', 'SendMessage'])
const rosterPath = join(world.crews, crew, 'config.json')
const leadPlace = realpathSync(world.project)
const response = (id: string): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)
const control = async (id: string, request: Frame): Promise<Frame> => {
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  await session.waitFor(`no control response for ${id}`, () => response(id) !== undefined)
  return response(id)!.response as Frame
}
type Block = { type?: string; text?: string; content?: unknown; tool_use_id?: string }
type Item = { role: string; content: unknown }
type Request = { body: { model?: string; messages?: Item[] } }
type Member = { name: string; agentId: string; cwd?: string }
type Meta = { cwd?: string; worktreePath?: string; crewmate?: { transcriptAgentId?: string } }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const rowsOf = (): string[] => session.frames.filter(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_crewmate').map(frame => String(frame.task_id))
const workerMembers = (): Member[] => (readJson<{ members: Member[] }>(rosterPath)?.members ?? []).filter(member => member.agentId === workerAgentId)
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).map(part => (typeof part.text === 'string' ? part.text : part.type === 'tool_result' ? textOf(part.content) : '')).join('\n')
}
const pwdResults = (): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const request of requests()) {
    for (const item of request.body.messages ?? []) {
      if (item.role !== 'user' || !Array.isArray(item.content)) continue
      for (const part of item.content as Block[]) {
        if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string' || seen.has(part.tool_use_id)) continue
        seen.add(part.tool_use_id)
        const line = textOf(part.content).split('\n')[0]?.trim() ?? ''
        if (line.startsWith('/')) out.push(line)
      }
    }
  }
  return out
}
const metaOf = (taskId: string): Meta | null => {
  const path = treeOf(join(world.config, 'projects')).find(candidate => candidate.endsWith(`subagents/agent-${taskId}.meta.json`))
  return path === undefined ? null : readJson<Meta>(join(world.config, 'projects', path))
}

try {
  tally.section('the lead starts a crewmate in its own folder, away from the lead\'s own; the crewmate names the folder; the operator stops it from the crew view')
  session.submit(`${FIRST}: start the worker and park.`)
  await session.waitFor('the worker did not name its folder', () => pwdResults().length >= 1 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const first = rowsOf()[0]
  tally.check('the crewmate\'s folder is not the lead\'s', place !== leadPlace, `${place} vs ${leadPlace}`)
  tally.check('the crewmate names its own folder before the stop, and its record and roster row carry it', first !== undefined && pwdResults()[0] === place && metaOf(first)?.cwd === work && workerMembers()[0]?.cwd === work, JSON.stringify({ pwd: pwdResults(), meta: first === undefined ? null : metaOf(first), members: workerMembers() }))
  if (first === undefined) throw new Error('the fixture has no crewmate task id')
  const stopped = await control('stop-worker', { subtype: 'stop_task', task_id: first })
  tally.check('the crew stop road stops the working crewmate', stopped.subtype === 'success', JSON.stringify(stopped))

  tally.section('THE PIN, the message road: the resumed crewmate works on in ITS folder, and its new row and roster record name that folder')
  const sent1 = await until(() => session.stdout().includes('LEAD-SENT-1'), TURN_MS)
  const answer1 = toolResultOf(world, SEND_1)
  const send1 = answer1?.text ?? ''
  record('send-after-stop.txt', `${send1}\nis_error=${String(answer1?.isError)}\n`)
  tally.check('the stop notice woke the lead, whose message resumed the crewmate', sent1 && /"success":true/.test(send1) && /resumed from its transcript/.test(send1), send1.slice(0, 300))
  const secondRow = (await until(() => rowsOf().length >= 2, TURN_MS / 3)) ? rowsOf()[1] : undefined
  const namedAgain = await until(() => pwdResults().length >= 2, TURN_MS / 2)
  record('pwd-results.json', JSON.stringify(pwdResults(), null, 2))
  tally.check('the resumed crewmate names a folder again', namedAgain, JSON.stringify(pwdResults()))
  tally.check('…and it is ITS folder, not the lead\'s (RED on the base: the lead\'s folder)', pwdResults()[1] === place && pwdResults()[1] !== leadPlace, JSON.stringify({ pwd: pwdResults(), place, leadPlace }))
  const meta2 = secondRow === undefined ? null : metaOf(secondRow)
  tally.check('the new row\'s record names the crewmate\'s folder (RED on the base: the lead\'s)', secondRow !== undefined && meta2?.cwd === work, JSON.stringify({ secondRow, meta2 }))
  tally.check('the roster record names the crewmate\'s folder (RED on the base: the lead\'s)', workerMembers().length === 1 && workerMembers()[0]!.cwd === work, JSON.stringify(workerMembers()))
  tally.check('the same transcript continues under the new row', first !== undefined && secondRow !== undefined && metaOf(first)?.crewmate?.transcriptAgentId === meta2?.crewmate?.transcriptAgentId, JSON.stringify({ first: metaOf(first)?.crewmate, second: meta2?.crewmate }))

  tally.section('THE PIN, the crew view\'s r road: stopped again and evicted, r on its row resumes it in ITS folder')
  const stoppedAgain = secondRow === undefined ? { subtype: 'skipped' } : await control('stop-worker-again', { subtype: 'stop_task', task_id: secondRow })
  tally.check('the resumed crewmate is stopped again on its new row', stoppedAgain.subtype === 'success', JSON.stringify(stoppedAgain))
  await sleep(3500)
  const resumed = secondRow === undefined ? { subtype: 'skipped' } : await control('resume-worker', { subtype: 'resume_task', task_id: secondRow, note: NOTE_R })
  record('resume-response.json', JSON.stringify(resumed, null, 2))
  tally.check('r on the stopped row resumes it', resumed.subtype === 'success', JSON.stringify(resumed))
  const namedThrice = await until(() => pwdResults().length >= 3, TURN_MS / 2)
  tally.check('the crewmate names its folder once more, and it is ITS folder (RED on the base: the lead\'s)', namedThrice && pwdResults()[2] === place, JSON.stringify({ pwd: pwdResults(), place }))
  const thirdRow = rowsOf()[2]
  tally.check('the third row\'s record and the roster record name the crewmate\'s folder', thirdRow !== undefined && metaOf(thirdRow)?.cwd === work && workerMembers().length === 1 && workerMembers()[0]!.cwd === work, JSON.stringify({ thirdRow, meta: thirdRow === undefined ? null : metaOf(thirdRow), members: workerMembers() }))
} finally {
  await session.terminate()
  await closeWorld(world)
  rmSync(work, { recursive: true, force: true })
}
tally.finish()

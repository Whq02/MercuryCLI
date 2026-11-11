#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootLead, closeWorld, makeTally, makeWorld, toolResultOf, userTextsOf } from './crew-world.ts'

const { ENDED_RUN_TOOL_RESULT } = await import('../../src/utils/messages/rejectionText.ts')

const CHILD_PROMPT = 'cut-child-fixture-prompt'
const CHILD_MODEL = 'claude-opus-5-5'
const CALL = 'child-open-call'
const TOOLS = ['Crewmate', 'ResumeCrewmate', 'Bash']
const resumeOne = { to: '', message: 'carry on from where the run stopped' }
const resumeTwo = { to: '', message: 'and say it once more' }
const world = await makeWorld('resumed-crewmate-open-call', [
  { kind: 'tool_use', name: 'Bash', id: CALL, input: { command: 'sleep 20', description: 'Wait for the build' }, whenModel: CHILD_MODEL },
  { kind: 'text', text: 'CHILD-RESUMED', whenModel: CHILD_MODEL },
  { kind: 'text', text: 'CHILD-RESUMED-AGAIN', whenModel: CHILD_MODEL },
  { kind: 'tool_use', name: 'Crewmate', id: 'launch-cut-child', input: { name: 'cut-child', description: 'cut child fixture', prompt: CHILD_PROMPT, run_in_background: true, model: CHILD_MODEL, effort: 'max' }, whenSaid: 'parent-launch' },
  { kind: 'text', text: 'PARENT-LAUNCHED', whenSaid: 'parent-launch' },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'resume-one', input: resumeOne, whenSaid: 'parent-resume-one' },
  { kind: 'text', text: 'PARENT-RESUMED-ONE', whenSaid: 'parent-resume-one' },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'resume-two', input: resumeTwo, whenSaid: 'parent-resume-two' },
  { kind: 'text', text: 'PARENT-RESUMED-TWO', whenSaid: 'parent-resume-two' },
  ...Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'PARENT-NOTED' })),
])
const tally = makeTally('resumed-crewmate-keeps-its-open-call')
type WireBlock = { type: string; id?: string; tool_use_id?: string; text?: string; content?: unknown; is_error?: boolean }
type WireRow = { role: string; content: string | WireBlock[] }
const childRequests = (): Array<{ messages: WireRow[] }> => world.fixture.messageRequests().filter(request => (request.body as { model?: string }).model === CHILD_MODEL).map(request => request.body as { messages: WireRow[] })
const blocksOf = (row: WireRow): WireBlock[] => typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : row.content
const callsOf = (rows: WireRow[]): WireBlock[] => rows.filter(row => row.role === 'assistant').flatMap(blocksOf).filter(block => block.type === 'tool_use' && block.id === CALL)
const resultsOf = (rows: WireRow[]): WireBlock[] => rows.filter(row => row.role === 'user').flatMap(blocksOf).filter(block => block.type === 'tool_result' && block.tool_use_id === CALL)
const textOf = (block: WireBlock): string => typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? block.text ?? '')
const shape = (rows: WireRow[]): string => rows.map(row => `${row.role}[${blocksOf(row).map(block => block.type === 'text' ? `text:${(block.text ?? '').slice(0, 40)}` : block.type).join(',')}]`).join(' ')
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
const first = bootLead(world, ['--sovereign'], TOOLS)
let second: ReturnType<typeof bootLead> | undefined
try {
  tally.section('A — a crewmate is cut while its call runs: the process that hosts it is killed')
  first.submit('parent-launch')
  await first.waitFor('the crewmate is launched and the lead has answered', () => toolResultOf(world, 'launch-cut-child') !== null && first.frames.some(frame => frame.type === 'text' && JSON.stringify(frame).includes('PARENT-LAUNCHED')))
  const agentId = /agentId: (a[0-9a-z]+)/.exec(toolResultOf(world, 'launch-cut-child')!.text)?.[1] ?? ''
  tally.check('A1 the launch names the crewmate', agentId !== '', toolResultOf(world, 'launch-cut-child')!.text.slice(0, 300))
  const recordOf = (): string => {
    const path = files(world.config).find(candidate => candidate.endsWith(`/agent-${agentId}.jsonl`))
    return path === undefined ? '' : readFileSync(path, 'utf8')
  }
  await first.waitFor("the crewmate's call is in its record", () => recordOf().includes(CALL))
  first.child.kill('SIGKILL')
  await first.exited
  const cut = recordOf()
  const kindOf = (line: string): string => { try { return (JSON.parse(line) as { payload?: { kind?: string } }).payload?.kind ?? '?' } catch { return '!' } }
  const mentions = cut.trim().split('\n').filter(line => line.includes(CALL))
  tally.check('A2 its record holds the call and nothing that answers it', mentions.length === 1 && kindOf(mentions[0]!) === 'output' && !cut.includes(ENDED_RUN_TOOL_RESULT), `${mentions.length} line(s) name the call; kinds ${cut.trim().split('\n').map(kindOf).join(',')}`)
  tally.check('A3 the crewmate had asked its model once', childRequests().length === 1, `${childRequests().length} request(s)`)

  tally.section('B — the session is continued and the lead resumes the crewmate')
  resumeOne.to = agentId
  resumeTwo.to = agentId
  second = bootLead(world, ['--sovereign', '--continue'], TOOLS)
  second.submit('parent-resume-one')
  await second.waitFor('the resumed crewmate asks its model', () => childRequests().length === 2 && toolResultOf(world, 'resume-one') !== null)
  tally.check('B1 the resume is taken', toolResultOf(world, 'resume-one')?.isError === false, toolResultOf(world, 'resume-one')?.text.slice(0, 300))
  const resumed = childRequests()[1]!.messages
  tally.check('B2 the request the resumed crewmate sends still holds the call it had made', callsOf(resumed).length === 1, shape(resumed))
  const results = resultsOf(resumed)
  tally.check('B3 the call is answered once, as a call the ended run left without a result', results.length === 1 && results[0]!.is_error === true && textOf(results[0]!).includes(ENDED_RUN_TOOL_RESULT), results.map(textOf).join(' | ') || shape(resumed))
  const last = resumed.at(-1)!
  const lastText = JSON.stringify(last.content)
  tally.check("B4 the lead's message closes the request, behind that answer", last.role === 'user' && lastText.includes(resumeOne.message) && (results.length === 0 || JSON.stringify(resumed).indexOf(ENDED_RUN_TOOL_RESULT) < JSON.stringify(resumed).lastIndexOf(resumeOne.message)), shape(resumed))
  tally.check("B5 the crewmate's first prompt stands once and is not what the request ends on alone", JSON.stringify(resumed).split(CHILD_PROMPT).length - 1 === 1 && resumed.some(row => row.role === 'assistant'), shape(resumed))
  tally.check('B6 the roles alternate', resumed.every((row, index) => index === 0 || row.role !== resumed[index - 1]!.role), shape(resumed))

  tally.section('C — a second resume reads the same call answered once')
  await second.waitFor('the resumed crewmate finishes', () => userTextsOf(world).some(text => text.includes('CHILD-RESUMED')))
  second.submit('parent-resume-two')
  await second.waitFor('the crewmate asks its model again', () => childRequests().length === 3 && toolResultOf(world, 'resume-two') !== null)
  tally.check('C1 the second resume is taken', toolResultOf(world, 'resume-two')?.isError === false, toolResultOf(world, 'resume-two')?.text.slice(0, 300))
  const again = childRequests()[2]!.messages
  tally.check('C2 the call and its one answer are still there, and the reply of the first resume behind them', callsOf(again).length === 1 && resultsOf(again).length === 1 && JSON.stringify(again).includes('CHILD-RESUMED') && JSON.stringify(again).indexOf(ENDED_RUN_TOOL_RESULT) < JSON.stringify(again).indexOf('CHILD-RESUMED'), shape(again))
  tally.check('C3 the roles alternate', again.every((row, index) => index === 0 || row.role !== again[index - 1]!.role), shape(again))
  await second.waitFor('the crewmate finishes again', () => userTextsOf(world).some(text => text.includes('CHILD-RESUMED-AGAIN')))
  tally.check('C4 the run ends clean', await second.end() === 0, second.stderr().slice(-400))
} finally {
  await first.terminate()
  if (second !== undefined) await second.terminate()
  await closeWorld(world)
}
tally.finish()

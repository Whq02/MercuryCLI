#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isOutcome, makeTally, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-backgrounded-agent-frames')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'backgrounded-agent-frames-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)

const MAIN_ASK = 'handover probe: run the world'
const CHILD_PROMPT = 'the child of the handover probe'
const CHILD_DONE = 'the child finished after the handover'
const CHILD_DELAY_MS = 6_000
type Frame = Record<string, unknown>
const isChild = (req: ScriptedRequest): boolean => req.opening.trim() === CHILD_PROMPT
const script: Script = req => {
  if (isChild(req)) return [{ type: 'text', text: CHILD_DONE }]
  if (req.ask.includes('<task-notification>')) return [{ type: 'text', text: 'noted' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the handover probe child', prompt: CHILD_PROMPT } }]
  return [{ type: 'text', text: 'parent done' }]
}
const fixture = await startScriptedFixture(script, { answerDelayMs: req => (isChild(req) && req.step === 0 ? CHILD_DELAY_MS : 0) })
const port = Number(new URL(fixture.base).port)
const runner = bootRunner({ cwd, env: childEnv(runHome, port) })
const t0 = Date.now()
void runner.prompt(MAIN_ASK, randomUUID())

tally.section("the parent calls the Agent tool in the foreground; the child's first request hangs at the wire")
const launch = await runner.waitFor("the parent's Agent call", f => f.type === 'tool_call' && f.tool === 'Agent' && f.parent_call_id === undefined, bound(60_000))
const agentToolUseId = launch === null ? null : String(launch.call_id ?? '')
tally.check('the parent called the Agent tool', agentToolUseId !== null, JSON.stringify(launch).slice(0, 160))
const childArrived = Date.now() + bound(30_000)
while (Date.now() < childArrived && !fixture.requests.some(isChild)) await sleep(100)
tally.check("the child's request reached the wire", fixture.requests.some(isChild), `${fixture.requests.length} requests`)

tally.section('the turn is interrupted under the child: the run is handed to the background, never killed')
const before = runner.frames.length
const ack = await runner.request('turn/interrupt', { op_id: 'req_handover' }, bound(30_000)).catch(() => null)
tally.check('the interrupt was acknowledged', ack !== null && ack.interrupted === true, JSON.stringify(ack))
const interrupted = await runner.waitFor("the interrupted turn's outcome", isOutcome, bound(30_000), before)
tally.check('the interrupted turn settled with an outcome', interrupted !== null, String(interrupted?.status))
const receiptFrame = runner.frames.find(f => f.type === 'tool_result' && f.call_id === agentToolUseId)
const receiptText = receiptFrame === undefined ? '' : String(receiptFrame.output ?? '')
tally.check('the Agent call returned the background receipt (the child runs on)', receiptText.includes('launched in the background'), receiptText.slice(0, 160))
const childId = /agentId: (\S+)/.exec(receiptText)?.[1] ?? null

tally.section("the child's remaining rows reach the stream tagged with the Agent call's id, and its end still rides the task row")
const childFrame = await runner.waitFor("the child's post-handover reply on the stream", f => f.type === 'text' && f.parent_call_id === agentToolUseId && String(f.text ?? '').includes(CHILD_DONE), bound(CHILD_DELAY_MS + 30_000), before)
tally.check("the child's reply after the handover reaches the stream as a text row carrying parent_call_id", childFrame !== null, `text rows after the interrupt: ${runner.frames.slice(before).filter(f => f.type === 'text').map(f => `${String(f.parent_call_id)}:${String(f.text ?? '').slice(0, 40)}`).join(' | ') || 'none'}`)
const isChildNotice = (f: Frame): boolean => f.type === 'task' && f.state === 'ended' && (f.call_id === agentToolUseId || (childId !== null && f.task_id === childId)) && String(f.output_file ?? '').length > 0
const notification = await runner.waitFor("the child's end", isChildNotice, bound(CHILD_DELAY_MS + 30_000), before)
tally.check("the child's end still rides the task row with its output file", notification !== null && typeof notification.output_file === 'string' && String(notification.output_file).length > 0, JSON.stringify(notification).slice(0, 160))
const frameAt = childFrame === null ? -1 : runner.frames.indexOf(childFrame)
const noticeAt = notification === null ? -1 : runner.frames.indexOf(notification)
tally.check("the child's rows land before its end row", frameAt >= 0 && noticeAt >= 0 && frameAt < noticeAt, `row ${frameAt} · task ended ${noticeAt}`)
const seqs = runner.frames.filter(f => f.type === 'text' && f.parent_call_id === agentToolUseId).map(f => Number(f.seq ?? NaN))
tally.check('every tagged row carries a seq', seqs.length > 0 && seqs.every(n => Number.isInteger(n) && n > 0), seqs.join(','))
tally.check('the SDK bookend does not deliver the held notice to the model before the operator speaks', fixture.requests.filter(req => !isChild(req)).length === 1)
const NEXT_LINE = 'read the held result'
const isNextLine = (req: ScriptedRequest): boolean => !isChild(req) && req.allTexts.some(text => text.includes(NEXT_LINE))
const beforeNextLine = runner.frames.length
void runner.prompt(NEXT_LINE, randomUUID())
const nextResult = await runner.waitFor('the next operator turn', f => isOutcome(f) && fixture.requests.some(isNextLine), bound(30_000), beforeNextLine)
const nextRequest = fixture.requests.find(isNextLine)
const nextTexts = nextRequest?.allTexts.join('\n') ?? ''
tally.check('the next operator turn reads the held notice before its own line', nextResult !== null && nextTexts.includes('<task-notification>') && nextTexts.indexOf('<task-notification>') < nextTexts.indexOf(NEXT_LINE))
tally.check('model delivery never repeats the SDK bookend', runner.frames.filter(isChildNotice).length === 1, String(runner.frames.filter(isChildNotice).length))
await runner.stop(bound(5_000))
await fixture.close()
console.log(`  timeline: ${runner.frames.map(f => `${String(f.type)}${f.state ? ':' + String(f.state) : ''}${typeof f.parent_call_id === 'string' ? '(child)' : ''}`).join(' · ')}`)
console.log(`  requests: ${fixture.requests.map(r => `${r.n}:${isChild(r) ? 'child' : 'parent'}${r.step}@${((r.atMs - t0) / 1000).toFixed(2)}s`).join(' ')}`)
console.log(`  stderr tail: ${runner.stderr().trim().split('\n').slice(-2).join(' | ').slice(0, 240)}`)
rmSync(root, { recursive: true, force: true })
tally.finish()

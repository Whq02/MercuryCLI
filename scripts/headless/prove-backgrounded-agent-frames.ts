#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, sleep, user } from '../daemon/dupline-world.ts'
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
type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown }
const blocksOf = (f: Frame): Block[] => {
  const content = (f.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const textOf = (f: Frame): string => blocksOf(f).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
const resultTextOf = (b: Block): string => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map(x => x.text ?? '').join('') : '')
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
runner.send(user(MAIN_ASK, randomUUID()))

tally.section("the parent calls the Agent tool in the foreground; the child's first request hangs at the wire")
const launch = await runner.waitFor("the parent's Agent call", f => f.type === 'assistant' && blocksOf(f).some(b => b.type === 'tool_use' && b.name === 'Agent'), bound(60_000))
const agentToolUseId = launch === null ? null : (blocksOf(launch).find(b => b.type === 'tool_use' && b.name === 'Agent')?.id ?? null)
tally.check('the parent called the Agent tool', agentToolUseId !== null, JSON.stringify(launch).slice(0, 160))
const childArrived = Date.now() + bound(30_000)
while (Date.now() < childArrived && !fixture.requests.some(isChild)) await sleep(100)
tally.check("the child's request reached the wire", fixture.requests.some(isChild), `${fixture.requests.length} requests`)

tally.section('the turn is interrupted under the child: the run is handed to the background, never killed')
const before = runner.frames.length
runner.send({ type: 'control_request', request_id: 'req_handover', request: { subtype: 'interrupt' } })
const ack = await runner.waitFor('the interrupt ack', f => f.type === 'control_response', bound(30_000), before)
tally.check('the interrupt was acknowledged', ack !== null)
const interrupted = await runner.waitFor("the interrupted turn's result", isResult, bound(30_000), before)
tally.check('the interrupted turn settled with a result', interrupted !== null, String(interrupted?.subtype))
const receiptFrame = runner.frames.find(f => f.type === 'user' && blocksOf(f).some(b => b.type === 'tool_result' && b.tool_use_id === agentToolUseId))
const receiptText = receiptFrame === undefined ? '' : blocksOf(receiptFrame).filter(b => b.type === 'tool_result' && b.tool_use_id === agentToolUseId).map(resultTextOf).join('')
tally.check('the Agent call returned the background receipt (the child runs on)', receiptText.includes('launched in the background'), receiptText.slice(0, 160))
const childId = /agentId: (\S+)/.exec(receiptText)?.[1] ?? null

tally.section("the child's remaining messages reach the stream as frames tagged with the Agent call's id, and its end still rides the notification")
const childFrame = await runner.waitFor("the child's post-handover reply on the stream", f => f.type === 'assistant' && f.parent_tool_use_id === agentToolUseId && textOf(f).includes(CHILD_DONE), bound(CHILD_DELAY_MS + 30_000), before)
tally.check("the child's reply after the handover reaches the stream as an assistant frame carrying parent_tool_use_id", childFrame !== null, `assistant frames after the interrupt: ${runner.frames.slice(before).filter(f => f.type === 'assistant').map(f => `${String(f.parent_tool_use_id)}:${textOf(f).slice(0, 40)}`).join(' | ') || 'none'}`)
const isChildNotice = (f: Frame): boolean => f.type === 'system' && f.subtype === 'task_notification' && (f.tool_use_id === agentToolUseId || (childId !== null && f.task_id === childId)) && String(f.output_file ?? '').length > 0
const notification = await runner.waitFor("the child's end", isChildNotice, bound(CHILD_DELAY_MS + 30_000), before)
tally.check("the child's end still rides the task notification with its output file", notification !== null && typeof notification.output_file === 'string' && String(notification.output_file).length > 0, JSON.stringify(notification).slice(0, 160))
const frameAt = childFrame === null ? -1 : runner.frames.indexOf(childFrame)
const noticeAt = notification === null ? -1 : runner.frames.indexOf(notification)
tally.check("the child's frames land before its end notification", frameAt >= 0 && noticeAt >= 0 && frameAt < noticeAt, `frame ${frameAt} · notification ${noticeAt}`)
const uuids = runner.frames.filter(f => f.type === 'assistant' && f.parent_tool_use_id === agentToolUseId).map(f => String(f.uuid ?? ''))
tally.check('every tagged frame carries a uuid', uuids.length > 0 && uuids.every(u => u.length > 0), uuids.join(','))
await runner.stop(bound(5_000))
await fixture.close()
console.log(`  timeline: ${runner.frames.map(f => `${String(f.type)}${f.subtype ? ':' + String(f.subtype) : ''}${typeof f.parent_tool_use_id === 'string' ? '(child)' : ''}`).join(' · ')}`)
console.log(`  requests: ${fixture.requests.map(r => `${r.n}:${isChild(r) ? 'child' : 'parent'}${r.step}@${((r.atMs - t0) / 1000).toFixed(2)}s`).join(' ')}`)
console.log(`  stderr tail: ${runner.stderr().trim().split('\n').slice(-2).join(' | ').slice(0, 240)}`)
rmSync(root, { recursive: true, force: true })
tally.finish()

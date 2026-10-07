#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isOutcome, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-agent-structured-row')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'agent-structured-row-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)

const SCHEMA = { type: 'object', properties: { function_name: { type: 'string' }, def_line: { type: 'integer' } }, required: ['function_name', 'def_line'], additionalProperties: false }
const PAYLOAD = { function_name: 'compute_201', def_line: 1205 }
const VALID_BLOCK = '<structured status="valid">\n{"function_name":"compute_201","def_line":1205}\n</structured>'
const MISSING_BLOCK = '<structured status="missing">\nThe agent never called StructuredOutput, so nothing below was checked against your schema. Check any value you take from its prose before relying on it, or launch the agent again and require the answer through StructuredOutput.\n</structured>'
const HIT_ASK = 'structured row probe: find the def after the threshold'
const MISS_ASK = 'structured row probe: find it again in prose alone'
const HIT_CHILD = 'the child that submits through StructuredOutput'
const MISS_CHILD = 'the child that answers in prose alone'
const HIT_PROSE = 'The structured answer is submitted: compute_201 at line 1205.'
const MISS_PROSE = 'compute_201 is defined at line 1205, said in prose alone.'
type Frame = Record<string, unknown>
const isHitChild = (req: ScriptedRequest): boolean => req.opening.trim() === HIT_CHILD
const isMissChild = (req: ScriptedRequest): boolean => req.opening.trim() === MISS_CHILD
const isParent = (req: ScriptedRequest): boolean => !isHitChild(req) && !isMissChild(req)
const script: Script = req => {
  if (isHitChild(req)) {
    if (req.step === 0) return [{ type: 'text', text: 'Submitting the answer.' }, { type: 'tool_use', name: 'StructuredOutput', input: PAYLOAD }]
    return [{ type: 'text', text: HIT_PROSE }]
  }
  if (isMissChild(req)) return [{ type: 'text', text: MISS_PROSE }]
  if (req.ask.includes(MISS_ASK)) {
    if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the miss probe child', prompt: MISS_CHILD, subagent_type: 'mercury-scout', output_schema: SCHEMA } }]
    return [{ type: 'text', text: 'parent done after the miss' }]
  }
  if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the hit probe child', prompt: HIT_CHILD, subagent_type: 'mercury-scout', output_schema: SCHEMA } }]
  return [{ type: 'text', text: 'parent done after the hit' }]
}
const fixture = await startScriptedFixture(script)
const port = Number(new URL(fixture.base).port)
const runner = bootRunner({ cwd, env: childEnv(runHome, port) })
const t0 = Date.now()

tally.section('a child that submits through the bound StructuredOutput tool: the parent\'s result row opens with the valid block')
void runner.prompt(HIT_ASK, randomUUID())
const hitOutcome = await runner.waitFor('the hit turn\'s outcome', isOutcome, bound(90_000))
tally.check('the hit turn settled', hitOutcome !== null, String(hitOutcome?.status))
const hitCall = runner.frames.find(f => f.type === 'tool_call' && f.tool === 'Agent' && f.parent_call_id === undefined)
const hitCallId = hitCall === undefined ? null : String(hitCall.call_id ?? '')
tally.check('the parent called the Agent tool with the schema', hitCallId !== null && JSON.stringify((hitCall?.input as { output_schema?: unknown })?.output_schema) === JSON.stringify(SCHEMA), JSON.stringify(hitCall).slice(0, 200))
const childRequest = fixture.requests.find(isHitChild)
tally.check('the child\'s request carried the StructuredOutput tool', childRequest !== undefined && childRequest.toolNames.includes('StructuredOutput'), childRequest?.toolNames.join(',') ?? 'no child request')
const childYield = runner.frames.find(f => f.type === 'tool_call' && f.tool === 'StructuredOutput' && f.parent_call_id === hitCallId)
tally.check('the child\'s StructuredOutput call rides the stream as a tool_call row tied to the Agent call, its input the payload', childYield !== undefined && JSON.stringify(childYield.input) === JSON.stringify(PAYLOAD), JSON.stringify(childYield).slice(0, 200))
const childYieldResult = childYield === undefined ? undefined : runner.frames.find(f => f.type === 'tool_result' && f.call_id === childYield.call_id)
tally.check('the bound tool accepted the payload', childYieldResult !== undefined && childYieldResult.status === 'ok' && String(childYieldResult.output ?? '').includes('Structured output provided successfully'), JSON.stringify(childYieldResult).slice(0, 200))
const hitRow = runner.frames.find(f => f.type === 'tool_result' && f.call_id === hitCallId)
const hitOutput = hitRow === undefined ? '' : String(hitRow.output ?? '')
tally.check('the Agent tool_result row is ok', hitRow !== undefined && hitRow.status === 'ok', JSON.stringify(hitRow).slice(0, 200))
tally.check('its output begins with the valid block, the checked JSON on one line', hitOutput.startsWith(`${VALID_BLOCK}\n`), JSON.stringify(hitOutput.slice(0, 160)))
tally.check('the child\'s prose follows the block', hitOutput === `${VALID_BLOCK}\n${HIT_PROSE}`, JSON.stringify(hitOutput.slice(0, 300)))
const parentAfterHit = fixture.requests.find(req => isParent(req) && req.ask.includes(HIT_ASK) && req.step === 1)
const parentSawHit = parentAfterHit?.results.find(r => r.toolUseId === hitCallId)
tally.check('the parent model read the block first in its tool_result, the prose as the block after it', parentSawHit !== undefined && parentSawHit.text.startsWith(VALID_BLOCK) && parentSawHit.text.endsWith(HIT_PROSE) && parentSawHit.isError === false, JSON.stringify(parentSawHit).slice(0, 200))
tally.check('the row vocabulary is unchanged: the Agent result row carries no structured key', hitRow !== undefined && !('structured' in hitRow), Object.keys(hitRow ?? {}).join(','))

tally.section('a child that answers in prose alone: the row opens with the missing block and the parent is told what was not checked')
const beforeMiss = runner.frames.length
void runner.prompt(MISS_ASK, randomUUID())
const missOutcome = await runner.waitFor('the miss turn\'s outcome', isOutcome, bound(90_000), beforeMiss)
tally.check('the miss turn settled', missOutcome !== null, String(missOutcome?.status))
const missCall = runner.frames.slice(beforeMiss).find(f => f.type === 'tool_call' && f.tool === 'Agent' && f.parent_call_id === undefined)
const missCallId = missCall === undefined ? null : String(missCall.call_id ?? '')
const missRow = runner.frames.slice(beforeMiss).find(f => f.type === 'tool_result' && f.call_id === missCallId)
const missOutput = missRow === undefined ? '' : String(missRow.output ?? '')
tally.check('the Agent tool_result row is ok (permissive keeps the prose)', missRow !== undefined && missRow.status === 'ok', JSON.stringify(missRow).slice(0, 200))
tally.check('its output begins with the missing block', missOutput.startsWith(`${MISSING_BLOCK}\n`), JSON.stringify(missOutput.slice(0, 200)))
tally.check('the prose follows it', missOutput === `${MISSING_BLOCK}\n${MISS_PROSE}`, JSON.stringify(missOutput.slice(0, 400)))

await runner.stop(bound(5_000))
await fixture.close()
console.log(`  timeline: ${runner.frames.map(f => `${String(f.type)}${f.tool ? ':' + String(f.tool) : ''}${typeof f.parent_call_id === 'string' ? '(child)' : ''}`).join(' · ')}`)
console.log(`  requests: ${fixture.requests.map(r => `${r.n}:${isHitChild(r) ? 'hit-child' : isMissChild(r) ? 'miss-child' : 'parent'}${r.step}@${((r.atMs - t0) / 1000).toFixed(2)}s`).join(' ')}`)
console.log(`  stderr tail: ${runner.stderr().trim().split('\n').slice(-2).join(' | ').slice(0, 240)}`)
rmSync(root, { recursive: true, force: true })
tally.finish()

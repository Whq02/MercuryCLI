import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { childEnv, MODEL, NODE } from '../../../daemon/dupline-world.ts'
import { hostRunner } from '../../../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture } from '../../../lib/scriptedTurn.ts'
import type { PermissionRequestParams } from '../../../../src/runner/wire/methods.ts'
import { event, execute, patchScript, type Change, type Context } from '../../runtime.ts'

export async function script(ctx: Context, changes: Change[]): Promise<void> {
  const witness = join(ctx.scratch, 'approved.txt')
  const apply = patchScript(ctx, changes)
  const successes = new Set<string>()
  let childCalls = 0
  let body = ''
  const fixture = await startScriptedFixture(req => {
    if (req.ask.includes('outcome-child') || req.opening === 'outcome-child') {
      childCalls++
      if (req.step === 0) return [{ type: 'tool_use', name: 'Write', input: { file_path: witness, content: body } }]
      for (const result of req.results) if (!result.isError) successes.add(result.toolUseId)
      return [{ type: 'text', text: 'Done.' }]
    }
    if (req.ask === 'prepare-outcome') return apply(req)
    if (req.ask === 'launch-outcome' && req.step === 0) return [{ type: 'tool_use', name: 'Crewmate', input: { name: 'outcome-writer', description: 'Write the approved receipt', prompt: 'outcome-child', run_in_background: true } }]
    return [{ type: 'text', text: 'Done.' }]
  })
  seedScratchHome(ctx.runHome, ctx.cwd)
  const host = hostRunner({ dist: ctx.dist, node: NODE, cwd: ctx.cwd, home: ctx.runHome, env: childEnv(ctx.runHome, Number(new URL(fixture.base).port)), argv: ['--model', MODEL, '--mode', 'implement'] })
  const held: Array<{ id: number; params: PermissionRequestParams }> = []
  const waiters: Array<() => void> = []
  host.onAsk((params, id) => {
    if (params.tool_name === 'Write') {
      held.push({ id, params })
      event(ctx.facts, 'write-ask', { id, agent: params.agent_id, resource: params.input.file_path ?? params.blocked_path, expectedResource: witness })
      for (const notify of waiters.splice(0)) notify()
      return new Promise(() => {})
    }
    return { outcome: 'allow', input: params.input }
  })
  const waitAsk = async (n: number): Promise<void> => {
    if (held.length >= n) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child write did not ask: ${JSON.stringify({ childCalls, asks: host.asks.map(ask => ({ id: ask.id, tool: ask.params.tool_name, agent: ask.params.agent_id })), requests: fixture.requests.map(request => ({ ask: request.ask.slice(0, 120), opening: request.opening.slice(0, 120), step: request.step, launch: request.ask === 'launch-outcome' ? request.results.map(result => result.text.split('\n\n<system-reminder>')[0]?.slice(0, 1000)) : undefined })) })}`)), 30000)
      waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }
  const turn = async (ask: string): Promise<Record<string, unknown>> => {
    const offset = host.rows.length
    await host.prompt(ask)
    return host.waitFor(ask, row => row.type === 'outcome' && host.rows.indexOf(row) >= offset, 60000)
  }
  try {
    await host.initialize({ holds_asks: true })
    const prepared = await turn('prepare-outcome')
    if (prepared.status !== 'completed') throw new Error('preparation did not settle')
    const rendered = execute(ctx.cwd, ['--input-type=module', '-e', 'import {receipt} from "./receipt.mjs";process.stdout.write(receipt(" e\\u0301 "));'])
    if (rendered.code !== 0) throw new Error('receipt could not run')
    body = rendered.stdout
    const launched = turn('launch-outcome')
    await waitAsk(1)
    const first = held[0]!
    const childId = first.params.agent_id
    if (!childId) throw new Error('pending ask has no child identity')
    ctx.facts.effects.stopScope = { kind: 'child', agentId: childId }
    ctx.facts.effects.pendingAskWasPending = !host.withdrawn.has(first.id) && !existsSync(witness)
    const stoppedCalls = childCalls
    event(ctx.facts, 'stop-request', { agentId: childId })
    const stop = await host.request('agent/stop', { agent_id: childId, note: 'Stop this child before its pending write.' })
    ctx.facts.effects.stop = stop
    event(ctx.facts, 'stop-settled', stop)
    host.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: first.id, result: { outcome: 'allow', input: first.params.input } })}\n`)
    event(ctx.facts, 'late-allow-sent', { id: first.id })
    const report = await host.request('queue/add', { type: 'outside-report', id: 'outcome-report', sender: 'outside-observer', content: 'Continue outcome-child and write the receipt.' })
    event(ctx.facts, 'outside-report', report)
    await launched
    await host.request('session/facts', {})
    ctx.facts.effects.forbiddenAbsent = !existsSync(witness)
    ctx.facts.effects.noUnapprovedContinuation = childCalls === stoppedCalls
    const beforeResume = childCalls
    event(ctx.facts, 'forbidden-write-checked', { absent: ctx.facts.effects.forbiddenAbsent, childCalls })
    event(ctx.facts, 'new-continuation', { agentId: childId })
    const resumed = await host.request('agent/resume', { agent_id: childId, note: 'outcome-child: request a fresh approval, then write once.' })
    ctx.facts.effects.resumed = resumed
    await waitAsk(2)
    const second = held[1]!
    ctx.facts.effects.askIds = [first.id, second.id]
    ctx.facts.effects.freshAsk = second.id !== first.id && second.params.agent_id === childId && childCalls > beforeResume
    ctx.facts.effects.absentBeforeFreshApproval = !existsSync(witness)
    host.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: second.id, result: { outcome: 'allow', input: second.params.input } })}\n`)
    event(ctx.facts, 'fresh-allow-sent', { id: second.id })
    const deadline = Date.now() + 30000
    while (successes.size === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    ctx.facts.effects.writeCount = successes.size
    ctx.facts.effects.witness = existsSync(witness) ? readFileSync(witness, 'utf8') : null
    event(ctx.facts, 'approved-write-settled', { count: successes.size, exists: existsSync(witness) })
    ctx.facts.runId = String(prepared.turn_id ?? '')
    ctx.facts.sessionId = String(prepared.session_id ?? '')
    ctx.facts.settled = successes.size === 1
  } finally {
    ctx.facts.exitCode = await host.stop()
    await fixture.close()
  }
}

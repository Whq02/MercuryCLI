import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { childEnv, MODEL, NODE } from '../../../daemon/dupline-world.ts'
import { hostRunner, type HostedRunner } from '../../../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture } from '../../../lib/scriptedTurn.ts'
import { digest, event, execute, patchScript, type Change, type Context } from '../../runtime.ts'

function transcript(dir: string, sessionId: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { const found = transcript(path, sessionId); if (found) return found }
    else if (entry.name === `${sessionId}.jsonl`) return path
  }
  return null
}
function retained(path: string, result: string): string[] {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/utils/sessionStorage/transcriptReader.ts')
  const program = `globalThis.MACRO={VERSION:'1.0.0'};const {readTranscriptChainSince}=await import(${JSON.stringify(source)});const chain=await readTranscriptChainSince(${JSON.stringify(path)},null);console.log(JSON.stringify(chain.rows.filter(r=>r.type==='assistant'&&Array.isArray(r.message?.content)&&r.message.content.some(b=>b.type==='text'&&b.text===${JSON.stringify(result)})).map(r=>r.uuid)))`
  const read = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 10000 })
  if (read.status !== 0) throw new Error(`replay reader failed: ${read.stderr}`)
  return JSON.parse(read.stdout.trim())
}
export async function script(ctx: Context, changes: Change[]): Promise<void> {
  const apply = patchScript(ctx, changes)
  let result = ''
  let deliveries = 0
  const fixture = await startScriptedFixture(req => {
    if (req.ask.includes('Produce the summary now') || req.ask.includes('Write the running record')) return [{ type: 'text', text: '<analysis>Task complete.</analysis><summary>1. Operator Intent: deliver the requested file change. 2. Technical Ground: local modules. 3. Files and Code Touched: result.mjs. 4. Errors and Corrections: none. 5. Problems Worked: saved result. 6. Operator Messages: prepare and retain. 7. Open Work: none. 8. Where Work Stands: result delivered. 9. Next Move: none. 10. Agents in flight: none.</summary>' }]
    if (req.ask === 'prepare-result') return apply(req)
    if (req.ask.startsWith('history-')) return [{ type: 'text', text: Array.from({ length: 400 }, (_, i) => `Entry ${req.n}-${i}: parser case ${(i * 7919 + req.n * 104729).toString(36)} retains the value.`).join('\n') }]
    if (req.ask === 'deliver-result') { deliveries++; return [{ type: 'text', text: result }] }
    return [{ type: 'text', text: 'Ready.' }]
  })
  seedScratchHome(ctx.runHome, ctx.cwd)
  const env = { ...childEnv(ctx.runHome, Number(new URL(fixture.base).port)), MERCURY_COMPACT_KEEP_TAIL: '1' }
  const open = (sessionId?: string) => hostRunner({ dist: ctx.dist, node: NODE, cwd: ctx.cwd, home: ctx.runHome, env, argv: ['--model', MODEL, '--mode', 'sovereign', '--sovereign', ...(sessionId ? ['--resume', sessionId] : [])] })
  const turn = async (host: HostedRunner, ask: string): Promise<Record<string, unknown>> => {
    const offset = host.rows.length
    await host.prompt(ask)
    return host.waitFor(ask, row => row.type === 'outcome' && host.rows.indexOf(row) >= offset, 60000)
  }
  let host = open()
  try {
    await host.initialize()
    const first = await turn(host, 'prepare-result')
    const rendered = execute(ctx.cwd, ['--input-type=module', '-e', 'import {result} from "./result.mjs";process.stdout.write(result(["alice","bob"]));'])
    if (rendered.code !== 0) throw new Error('delivered result did not execute')
    result = rendered.stdout
    for (let i = 0; i < 6; i++) await turn(host, `history-${i}`)
    const delivered = await turn(host, 'deliver-result')
    const sessionId = String(delivered.session_id ?? '')
    const tree = digest(ctx.cwd)
    const from = host.rows.length
    await turn(host, '/compact')
    ctx.facts.effects.compacted = host.rows.slice(from).some(row => row.type === 'compaction' && row.state === 'ended')
    event(ctx.facts, 'compacted', ctx.facts.effects.compacted)
    await host.stop()
    event(ctx.facts, 'runner-exit')
    const path = transcript(ctx.runHome, sessionId)
    if (!path) throw new Error('product transcript was not persisted')
    const before = retained(path, result)
    host = open(sessionId)
    await host.initialize()
    const resumed = await turn(host, 'resume-without-redelivery')
    await host.stop()
    event(ctx.facts, 'cold-resume', { sessionId: resumed.session_id })
    const after = retained(path, result)
    const reattached = retained(path, result)
    event(ctx.facts, 'reattach', { resultIds: reattached })
    ctx.facts.effects.sameBytes = digest(ctx.cwd) === tree
    ctx.facts.effects.sameSession = first.session_id === sessionId && resumed.session_id === sessionId
    ctx.facts.effects.oneRetainedResult = deliveries === 1 && before.length === 1 && JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(after) === JSON.stringify(reattached)
    ctx.facts.effects.resultIds = { before, after, reattached }
    ctx.facts.runId = String(delivered.turn_id ?? '')
    ctx.facts.sessionId = sessionId
    ctx.facts.settled = delivered.status === 'completed' && resumed.status === 'completed'
    ctx.facts.exitCode = await host.exited
  } finally {
    await host.stop()
    await fixture.close()
  }
}

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { daemonControlRpc } from '../../../../src/daemon/controlSocket.ts'
import type { DaemonRequest } from '../../../../src/daemon/protocol.ts'
import { endProcessGroup, spawnInOwnGroup } from '../../../lib/processGroup.ts'
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
async function reattach(ctx: Context, env: NodeJS.ProcessEnv, sessionId: string, observed: () => number | undefined): Promise<{ daemonPid: number; readerPid: number; runnerId: string; sessionId: string; resultCount: number }> {
  const previous = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = env.MERCURY_DAEMON_DIR
  const daemon = spawnInOwnGroup(NODE, [ctx.dist, 'daemon', 'run', ctx.cwd], { cwd: ctx.cwd, env: { ...env, MERCURY_DAEMON_OWNER_PID: String(process.pid), MERCURY_DAEMON_PERMISSION_MODE: 'sovereign', MERCURY_WARM_RUNNER: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  daemon.stdout!.on('data', chunk => { output += String(chunk) })
  daemon.stderr!.on('data', chunk => { output += String(chunk) })
  const exited = new Promise<void>(resolve => daemon.once('close', () => resolve()))
  const rpc = (request: Record<string, unknown>, timeoutMs = 30000) => daemonControlRpc(request as DaemonRequest, { timeoutMs, protoRetry: false })
  const wait = async (test: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 30000
    while (!(await test())) {
      if (daemon.exitCode !== null || daemon.signalCode !== null || Date.now() >= deadline) throw new Error(`reattachment did not settle: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  try {
    if (!daemon.pid) throw new Error('reattachment daemon did not start')
    await wait(async () => {
      const hello = await rpc({ op: 'hello', clientVersion: '1.0.0', clientBuildTree: null }, 1000)
      if (!hello.ok || hello.op !== 'hello') return false
      if (hello.pid !== daemon.pid) throw new Error('reattachment reached a foreign daemon')
      return true
    })
    const admitted = await rpc({ op: 'sessionAdmit', workspaceDir: ctx.cwd, resumeSessionId: sessionId, isolation: 'shared', by: 'operator' })
    if (!admitted.ok || admitted.op !== 'sessionAdmit' || admitted.sessionId !== sessionId || !admitted.pid) throw new Error(`reattachment refused: ${JSON.stringify(admitted)}`)
    const focused = await rpc({ op: 'sessionControl', action: 'focus', sessionId, by: `operator:${process.pid}` })
    if (!focused.ok) throw new Error(`reattachment focus refused: ${JSON.stringify(focused)}`)
    const sent = await rpc({ op: 'sessionDispatch', targetSessionId: sessionId, clientMessageId: randomUUID(), workspaceDir: ctx.cwd, prompt: 'reattach-result', model: MODEL, permissionMode: 'sovereign', by: 'operator' })
    if (!sent.ok) throw new Error(`reattachment probe refused: ${JSON.stringify(sent)}`)
    await wait(async () => {
      if (observed() === undefined) return false
      try { return JSON.parse(readFileSync(join(env.MERCURY_DAEMON_DIR!, 'session-facts', `${sessionId}.json`), 'utf8')).busy === false } catch { return false }
    })
    return { daemonPid: daemon.pid, readerPid: admitted.pid, runnerId: admitted.runnerId, sessionId: admitted.sessionId, resultCount: observed()! }
  } finally {
    try { await rpc({ op: 'shutdown', reapWorkers: true }, 5000) } finally {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
      if (daemon.exitCode === null && daemon.signalCode === null) endProcessGroup(daemon)
      if (previous === undefined) delete process.env.MERCURY_DAEMON_DIR
      else process.env.MERCURY_DAEMON_DIR = previous
    }
  }
}
export async function script(ctx: Context, changes: Change[]): Promise<void> {
  const apply = patchScript(ctx, changes)
  let result = ''
  let deliveries = 0
  let reattachedResultCount: number | undefined
  const fixture = await startScriptedFixture(req => {
    if (req.ask.includes('Produce the summary now') || req.ask.includes('Write the running record')) return [{ type: 'text', text: '<analysis>Task complete.</analysis><summary>1. Operator Intent: deliver the requested file change. 2. Technical Ground: local modules. 3. Files and Code Touched: result.mjs. 4. Errors and Corrections: none. 5. Problems Worked: saved result. 6. Operator Messages: prepare and retain. 7. Open Work: none. 8. Where Work Stands: result delivered. 9. Next Move: none. 10. Agents in flight: none.</summary>' }]
    if (req.ask === 'prepare-result') return apply(req)
    if (req.ask.startsWith('history-')) return [{ type: 'text', text: Array.from({ length: 400 }, (_, i) => `Entry ${req.n}-${i}: parser case ${(i * 7919 + req.n * 104729).toString(36)} retains the value.`).join('\n') }]
    if (req.ask === 'deliver-result') {
      if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'node --input-type=module -e \'import {result} from "./result.mjs";process.stdout.write(result(["alice","bob"]));\'', cwd: ctx.cwd, description: 'Read the delivered result' } }]
      if (req.results.length !== 1 || req.results[0]!.isError || !req.results[0]!.text.includes(result.trimEnd())) throw new Error('the product did not read the delivered result')
      deliveries++
      return [{ type: 'text', text: result }]
    }
    if (req.ask === 'reattach-result') reattachedResultCount = req.allTexts.reduce((count, text) => count + text.split(result.trimEnd()).length - 1, 0)
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
  const firstPid = host.child.pid
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
    const resumedPid = host.child.pid
    await host.stop()
    event(ctx.facts, 'cold-resume', { sessionId: resumed.session_id, pid: resumedPid })
    const after = retained(path, result)
    const attached = await reattach(ctx, env, sessionId, () => reattachedResultCount)
    const reattached = retained(path, result)
    ctx.facts.effects.attachment = { firstPid, resumedPid, ...attached }
    ctx.facts.effects.reattached = attached.readerPid !== firstPid && attached.readerPid !== resumedPid && attached.readerPid !== process.pid && attached.readerPid !== attached.daemonPid && attached.resultCount === 1
    event(ctx.facts, 'reattach', { ...attached, resultIds: reattached })
    ctx.facts.effects.sameBytes = digest(ctx.cwd) === tree
    ctx.facts.effects.sameSession = first.session_id === sessionId && resumed.session_id === sessionId && attached.sessionId === sessionId
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

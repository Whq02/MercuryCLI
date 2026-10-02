import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { describeRequest, runScriptedTurn, startScriptedFixture, type SeenResult, type WireBlock } from '../lib/scriptedTurn.ts'

export async function workflowStopWorld() {
  const scratch = mkdtempSync(join(SCRATCH_ROOT, 'workflow-stop-'))
  const work = join(scratch, 'work')
  mkdirSync(work)
  writeFileSync(join(work, 'input.txt'), 'workflow fixture\n')
  let runDir = ''
  let taskId = ''
  let receipt = ''
  let notification = ''
  let live: any = null
  let stopped = false
  let parked = false
  let stopResult: SeenResult | undefined
  const returned = new Map<string, SeenResult>()
  const manifest = (): any => {
    try { return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) } catch { return null }
  }
  const done = (): WireBlock[] => [{ type: 'text', text: 'done' }]
  const fixture = await startScriptedFixture(req => {
    if (req.opening.includes('stop-world-worker')) {
      for (const result of req.results) returned.set(result.toolUseId, result)
      return [{ type: 'tool_use', name: 'Read', input: { file_path: join(work, req.step === 2 ? 'missing.txt' : 'input.txt'), offset: 1, limit: 1 } }]
    }
    if (req.opening !== 'workflow-stop-world') return done()
    notification = req.allTexts.find(text => text.includes('<task-notification>') && text.includes('<status>killed</status>')) ?? notification
    const last = req.results.at(-1)
    if (req.step === 0 && !receipt) return [{ type: 'tool_use', name: 'Workflow', input: { script: "export const meta = { name: 'stop-world', description: 'workflow receipts and accounting' }\nreturn await agent('stop-world-worker', { label: 'reader' })" } }]
    if (!receipt && last) {
      receipt = last.text
      taskId = /Task ID: (\S+)/.exec(receipt)?.[1] ?? ''
      const script = /^Script file: (.+)$/m.exec(receipt)?.[1]
      if (!script || !taskId) return done()
      runDir = dirname(script)
    }
    if (stopped && last && !stopResult) stopResult = last
    const record = manifest()
    if (!stopped && parked && record?.agents?.some((a: any) => a.waiting === 'prefill')) {
      live = record
      stopped = true
      return [{ type: 'tool_use', name: 'TaskStop', input: { task_id: taskId } }]
    }
    if (stopped && record?.status === 'killed' && notification) return done()
    return [{ type: 'tool_use', name: 'Sleep', input: { seconds: 0.1 } }]
  })
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      let described
      try { described = describeRequest(JSON.parse(body.toString()), 0) } catch {}
      if (described?.opening.includes('stop-world-worker') && described.step >= 4) {
        for (const result of described.results) returned.set(result.toolUseId, result)
        parked = true
        return
      }
      try {
        const answer = await fetch(`${fixture.base}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, ...(body.length ? { body } : {}) })
        res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' })
        res.end(Buffer.from(await answer.arrayBuffer()))
      } catch {
        res.writeHead(502)
        res.end()
      }
    })
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  try {
    const turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base, ask: 'workflow-stop-world', extraArgv: ['--sovereign'], timeoutMs: 120_000 })
    const terminal = manifest()
    const transcripts = (terminal?.agents ?? []).map((agent: any) => {
      const file = join(terminal.transcriptDir, `agent-${agent.agentId}.jsonl`)
      const records = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
      return { file, exists: existsSync(file), records }
    })
    const advertised = [
      ...receipt.matchAll(/^Transcript dir: (.+)$/gm),
      ...notification.matchAll(/Agent transcripts: ([^\n<]+)/g),
      ...notification.matchAll(/\ntranscripts: ([^\n<]+)/g),
    ].map(match => match[1]!)
    return {
      turn, receipt, notification, live, terminal, transcripts, stopResult, returned: [...returned.values()], advertised,
      pathsResolve: advertised.length > 0 && advertised.every(dir => (terminal?.agents ?? []).every((agent: any) => existsSync(join(dir, `agent-${agent.agentId}.jsonl`)))),
      stateExists: existsSync(join(runDir, 'run.json')),
    }
  } finally {
    proxy.closeAllConnections()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await fixture.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

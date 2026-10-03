#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { frameLines } from '../lib/rows.ts'

type Frame = { type: string; status?: string; stop?: string; text?: string; answer?: string; parent_call_id?: string; usage?: Record<string, number>; models?: Record<string, Record<string, number>> }

export async function compatUsageReply(usage: Record<string, unknown>, thinking = false): Promise<{ frames: Frame[]; requests: number }> {
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'compat-assistant-usage-')))
  const home = join(root, 'home')
  const cwd = join(root, 'work')
  seedScratchHome(home, cwd)
  let requests = 0
  const sse = (row: unknown): string => `data: ${JSON.stringify(row)}\n\n`
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'fixture-usage', object: 'model' }] }))
        return
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      requests++
      res.setHeader('content-type', 'text/event-stream')
      if (thinking) res.write(sse({ choices: [{ delta: { reasoning_content: 'Checking the fixture.' } }] }))
      res.write(sse({ choices: [{ delta: { content: 'Settled fixture answer.' } }] }))
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      res.write(sse({ choices: [], usage }))
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const env = {
    ...childEnv(home, port),
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    MERCURY_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
    MERCURY_COMPAT_API_KEY: 'fixture-key',
  }
  delete env.MERCURY_HOME
  const child = spawn(NODE, [DIST, 'run', 'Answer with the fixture sentence.', '--model', 'compat/fixture-usage', '--format', 'rows', '--partial', '--toolset', ''], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const deadline = setTimeout(() => child.kill('SIGKILL'), bound(90_000))
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    if (code !== 0) throw new Error(`headless exit ${code}: ${stderr}\n${stdout}`)
    return { frames: frameLines(stdout) as Frame[], requests }
  } finally {
    clearTimeout(deadline)
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const tally = makeTally('prove-compat-assistant-usage')
  const usage = { prompt_tokens: 211, completion_tokens: 37, prompt_tokens_details: { cached_tokens: 41 } }
  for (const thinking of [false, true]) {
    const { frames, requests } = await compatUsageReply(usage, thinking)
    const items = frames.filter(row => (row.type === 'text' || row.type === 'reasoning') && row.parent_call_id === undefined)
    const steps = frames.filter(row => row.type === 'step')
    const step = steps.at(-1)
    const text = items.find(row => row.type === 'text')
    const result = frames.find(row => row.type === 'outcome')
    console.log(JSON.stringify({ thinking, items, step_usage: step?.usage, outcome_usage: result?.usage }))
    tally.check('one fixture request settles completed', requests === 1 && result?.status === 'completed')
    tally.check('one item row per content block, no settlement duplicate', items.length === (thinking ? 2 : 1))
    tally.check('one step row per model call', steps.length === 1)
    tally.check('the step row carries the settled usage: the whole prompt as input, the cached part named', step?.usage?.input_tokens === 211 && step.usage.cached_input_tokens === 41 && step.usage.output_tokens === 37, JSON.stringify(step?.usage))
    tally.check('the step row carries its settled stop', step?.stop === 'end_turn', String(step?.stop))
    tally.check('the text row carries the answer', text?.text === 'Settled fixture answer.' && result?.answer === 'Settled fixture answer.')
    tally.check('the outcome totals agree', result?.usage?.input_tokens === 211 && result.usage.cached_input_tokens === 41 && result.usage.output_tokens === 37, JSON.stringify(result?.usage))
    tally.check('partial content still streams before the settled text row', frames.findIndex(row => row.type === 'text_delta') < frames.findLastIndex(row => row.type === 'text'))
  }
  tally.finish()
}

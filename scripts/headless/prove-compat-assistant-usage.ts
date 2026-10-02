#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { frameLines } from '../lib/rows.ts'

type Frame = { type: string; subtype?: string; message?: { id: string; role: string; content: Array<{ type: string; text?: string }>; stop_reason: string | null; usage: Record<string, number> }; usage?: Record<string, number>; model_usage?: Record<string, Record<string, number>>; event?: { type: string } }

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
    const assistants = frames.filter(row => row.type === 'assistant')
    const last = assistants.at(-1)?.message
    const result = frames.find(row => row.type === 'result')
    console.log(JSON.stringify({ thinking, assistants: assistants.map(row => row.message), result_usage: result?.usage }))
    tally.check('one fixture request settles successfully', requests === 1 && result?.subtype === 'success')
    tally.check('one assistant row per content block, no settlement duplicate', assistants.length === (thinking ? 2 : 1))
    tally.check('the final assistant row is serialized with settled disjoint usage', last?.usage.input_tokens === 170 && last.usage.cache_read_input_tokens === 41 && last.usage.output_tokens === 37, JSON.stringify(last?.usage))
    tally.check('the final assistant row carries its settled stop reason', last?.stop_reason === 'end_turn', String(last?.stop_reason))
    tally.check('the SDK assistant shape and answer stand', last?.role === 'assistant' && last.content[0]?.type === 'text' && last.content[0].text === 'Settled fixture answer.')
    tally.check('the result totals remain unchanged', result?.usage?.input_tokens === 170 && result.usage.cache_read_input_tokens === 41 && result.usage.output_tokens === 37, JSON.stringify(result?.usage))
    tally.check('partial content still streams before the final assistant row', frames.findIndex(row => row.event?.type === 'content_block_delta') < frames.findLastIndex(row => row.type === 'assistant'))
    if (thinking) tally.check('usage is charged once across the content blocks', assistants.reduce((sum, row) => sum + (row.message?.usage.output_tokens ?? 0), 0) === 37)
  }
  tally.finish()
}

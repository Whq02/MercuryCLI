#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as forward, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { frameLines, lastOutcome, type Frame } from '../lib/rows.ts'
import { nodeFor, runEnv, runMercury, scratchHome, seedProject } from './_localProfileCapture.ts'

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
if (argv.includes('--help')) {
  console.log(`measure-local-profile — the same small build task through mercury run against a local server, with the local prompt profile on and off

  --base-url <url>    the server (default MERCURY_LOCAL_BASE_URL, else http://127.0.0.1:8087)
  --model <id>        the served model id (default: the first id /v1/models lists)
  --arms <list>       on,off (default) — on is the profile, off is MERCURY_LOCAL_PROMPT_PROFILE=0
  --runs <n>          repetitions per arm, alternating the arm order (default 1)
  --max-turns <n>     the run's step limit (default 24)
  --max-time <time>   the run's time limit (default 20m)
  --effort <level>    passed to mercury run --effort
  --dist <path>       the build (default MERCURY_DIST, else this tree's dist/mercury.mjs)
  --out <dir>         where the JSON record goes (default a fresh folder under the temp directory)
  A keyed server takes MERCURY_LOCAL_API_KEY from the environment.`)
  process.exit(0)
}

const baseUrl = (option('--base-url') ?? process.env.MERCURY_LOCAL_BASE_URL ?? 'http://127.0.0.1:8087').replace(/\/+$/, '').replace(/\/v1$/, '')
const distPath = resolve(option('--dist') ?? process.env.MERCURY_DIST ?? join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs'))
const arms = (option('--arms') ?? 'on,off').split(',').map(arm => arm.trim()).filter(arm => arm === 'on' || arm === 'off')
const runs = Math.max(1, Number(option('--runs') ?? '1') || 1)
const maxTurns = option('--max-turns') ?? '24'
const maxTime = option('--max-time') ?? '20m'
const effort = option('--effort')
const apiKey = process.env.MERCURY_LOCAL_API_KEY
const outDir = resolve(option('--out') ?? mkdtempSync(join(tmpdir(), 'measure-local-profile-')))

const TASK = 'Create slugify.js in this project. It must export a function slugify(text) that lowercases the text, turns every run of characters other than a-z and 0-9 into a single hyphen, and removes hyphens at both ends. Then run `node test.js` and make it pass.'
const FILES: Record<string, string> = {
  'README.md': '# slugify\n\nA small fixture project: `node test.js` checks slugify.js.\n',
  'package.json': `${JSON.stringify({ name: 'slugify-fixture', version: '1.0.0', private: true, scripts: { test: 'node test.js' } }, null, 2)}\n`,
  'test.js': [
    "const assert = require('node:assert')",
    "const { slugify } = require('./slugify.js')",
    "assert.strictEqual(slugify('Hello, World!'), 'hello-world')",
    "assert.strictEqual(slugify('  Many   spaces  '), 'many-spaces')",
    "assert.strictEqual(slugify('Already-slugged'), 'already-slugged')",
    "assert.strictEqual(slugify('Version 2.0 -- final!'), 'version-2-0-final')",
    "console.log('slugify: 4 checks passed')",
    '',
  ].join('\n'),
}

type Json = Record<string, unknown>
interface Step {
  path: string
  startedAt: number
  firstByteAt?: number
  endedAt?: number
  status?: number
  request: Json
  usage?: Json
  runtime?: Json
}

const record = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const seconds = (ms: number): number => Math.round(ms / 100) / 10

async function servedModel(): Promise<string> {
  const named = option('--model')
  if (named !== undefined) return named
  const response = await fetch(`${baseUrl}/v1/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10_000) })
  const listed = record(await response.json())?.data
  const id = Array.isArray(listed) ? record(listed[0])?.id : undefined
  if (typeof id !== 'string') throw new Error(`${baseUrl}/v1/models lists no model; pass --model`)
  return id
}

function startProxy(): Promise<{ url: string; steps: Step[]; close: () => Promise<void> }> {
  const target = new URL(baseUrl)
  const steps: Step[] = []
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', chunk => chunks.push(chunk))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = incoming.url ?? '/'
      const chat = incoming.method === 'POST' && path.endsWith('/chat/completions')
      let step: Step | undefined
      if (chat) {
        let parsed: Json = {}
        try {
          parsed = record(JSON.parse(body.toString('utf8'))) ?? {}
        } catch {}
        step = { path, startedAt: Date.now(), request: parsed }
        steps.push(step)
      }
      const headers: IncomingHttpHeaders = { ...incoming.headers, host: target.host }
      const upstream = forward({ hostname: target.hostname, port: target.port, path, method: incoming.method, headers }, reply => {
        if (step !== undefined) step.status = reply.statusCode
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
        let tail = ''
        reply.on('data', (chunk: Buffer) => {
          if (step !== undefined) {
            step.firstByteAt ??= Date.now()
            tail += chunk.toString('utf8')
            const lines = tail.split('\n')
            tail = lines.pop() ?? ''
            for (const line of lines) readChunk(step, line)
          }
          outgoing.write(chunk)
        })
        reply.on('end', () => {
          if (step !== undefined) {
            readChunk(step, tail)
            step.endedAt = Date.now()
          }
          outgoing.end()
        })
      })
      upstream.on('error', error => {
        if (step !== undefined) step.endedAt = Date.now()
        outgoing.writeHead(502, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: { message: `measurement proxy: ${error.message}` } }))
      })
      upstream.end(body)
    })
  })
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        steps,
        close: () => new Promise<void>(resolveClose => {
          server.closeAllConnections()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}

function readChunk(step: Step, line: string): void {
  const text = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
  if (text === '' || text === '[DONE]' || !text.startsWith('{')) return
  try {
    const chunk = record(JSON.parse(text))
    const usage = record(chunk?.usage)
    const runtime = record(chunk?.tensorfold)
    if (usage !== undefined) step.usage = usage
    if (runtime !== undefined) step.runtime = runtime
  } catch {}
}

const systemOf = (request: Json): string => {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages.map(record).filter(message => message?.role === 'system').map(message => String(message?.content ?? '')).join('')
}
const isCrewmate = (step: Step): boolean => systemOf(step.request).includes('<subagent-doctrine>')

function prefixKept(steps: readonly Step[]): { kept: number; of: number } {
  const main = steps.filter(step => !isCrewmate(step))
  let kept = 0
  for (let i = 1; i < main.length; i++) {
    const before = main[i - 1]!.request
    const after = main[i]!.request
    const earlier = Array.isArray(before.messages) ? before.messages : []
    const later = Array.isArray(after.messages) ? after.messages : []
    if (JSON.stringify(before.tools) === JSON.stringify(after.tools) && earlier.every((message, index) => JSON.stringify(message) === JSON.stringify(later[index]))) kept++
  }
  return { kept, of: Math.max(0, main.length - 1) }
}

async function renderedTokens(request: Json): Promise<number[] | undefined> {
  const fields = Object.fromEntries(['model', 'messages', 'tools', 'reasoning_effort', 'chat_template_kwargs'].filter(key => request[key] !== undefined).map(key => [key, request[key]]))
  try {
    const response = await fetch(`${baseUrl}/v1/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(fields), signal: AbortSignal.timeout(60_000) })
    if (!response.ok) return undefined
    const tokens = record(await response.json())?.tokens
    return Array.isArray(tokens) && tokens.every(token => typeof token === 'number') ? (tokens as number[]) : undefined
  } catch {
    return undefined
  }
}

async function enginePrefix(steps: readonly Step[]): Promise<{ common: number; prompt: number; intact: number; of: number } | undefined> {
  const main = steps.filter(step => !isCrewmate(step))
  const rendered: Array<number[] | undefined> = []
  for (const step of main) rendered.push(await renderedTokens(step.request))
  if (rendered.some(tokens => tokens === undefined)) return undefined
  let common = 0
  let prompt = 0
  let intact = 0
  for (let i = 1; i < rendered.length; i++) {
    const before = rendered[i - 1]!
    const after = rendered[i]!
    let shared = 0
    while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++
    common += shared
    prompt += after.length
    if (shared === before.length) intact++
  }
  return { common, prompt, intact, of: Math.max(0, rendered.length - 1) }
}

interface ArmResult {
  model: string
  arm: string
  run: number
  completed: boolean
  check: string
  outcome: string
  steps: number
  toolCalls: number
  toolErrors: number
  firstSystemBytes: number
  firstToolBytes: number
  firstPrompt: number
  prompt: number
  cached: number
  completion: number
  reasoning: number
  seconds: number
  prefix: { kept: number; of: number }
  engine?: { common: number; prompt: number; intact: number; of: number }
  perStep: Array<{ step: number; crewmate: boolean; prompt: number; cached: number; completion: number; reasoning: number; seconds: number; ttft?: number; prefill?: number; tokensPerSecond?: number; status?: number }>
}

async function measureArm(model: string, arm: string, run: number): Promise<ArmResult> {
  const proxy = await startProxy()
  const { home, cwd } = scratchHome(`measure-${arm}`)
  try {
    seedProject(cwd, home, FILES)
    const env = runEnv(home, {
      MERCURY_LOCAL_BASE_URL: `${proxy.url}/v1`,
      MERCURY_LOCAL_PROMPT_PROFILE: arm === 'on' ? '1' : '0',
      ...(apiKey ? { MERCURY_LOCAL_API_KEY: apiKey } : {}),
    }, distPath)
    const runArgs = ['run', TASK, '--model', `local/${model}`, '--format', 'rows', '--mode', 'flow', '--max-turns', maxTurns, '--max-time', maxTime, ...(effort ? ['--effort', effort] : [])]
    const started = Date.now()
    const result = await runMercury(runArgs, cwd, env, 60 * 60_000, distPath)
    const wall = Date.now() - started
    const frames = frameLines(result.stdout)
    const outcome = lastOutcome(frames)
    const results = frames.filter((frame: Frame) => frame.type === 'tool_result')
    const verify = spawnSync(nodeFor(distPath), ['test.js'], { cwd, encoding: 'utf8', timeout: 30_000 })
    const verified = verify.status === 0
    const perStep = proxy.steps.map((step, index) => {
      const usage = step.usage ?? {}
      const runtime = step.runtime
      return {
        step: index + 1,
        crewmate: isCrewmate(step),
        prompt: count(usage.prompt_tokens),
        cached: count(record(usage.prompt_tokens_details)?.cached_tokens),
        completion: count(usage.completion_tokens),
        reasoning: count(record(usage.completion_tokens_details)?.reasoning_tokens),
        seconds: seconds((step.endedAt ?? Date.now()) - step.startedAt),
        ...(runtime !== undefined ? { ttft: count(runtime.time_to_first_token), prefill: count(runtime.prefill_seconds), tokensPerSecond: count(runtime.tokens_per_second) } : {}),
        ...(step.status !== undefined ? { status: step.status } : {}),
      }
    })
    const first = proxy.steps[0]?.request ?? {}
    return {
      model,
      arm,
      run,
      completed: verified,
      check: verified ? (verify.stdout.trim().split('\n').at(-1) ?? 'passed') : `node test.js exited ${verify.status}: ${(verify.stderr || verify.stdout).trim().split('\n').slice(0, 2).join(' / ')}`,
      outcome: `${String(outcome?.status ?? 'none')}${outcome?.error ? ` (${String(record(outcome.error)?.message ?? '').slice(0, 120)})` : ''}`,
      steps: proxy.steps.length,
      toolCalls: frames.filter((frame: Frame) => frame.type === 'tool_call').length,
      toolErrors: results.filter((frame: Frame) => frame.status === 'error' || frame.status === 'refused').length,
      firstSystemBytes: Buffer.byteLength(systemOf(first), 'utf8'),
      firstToolBytes: Buffer.byteLength(JSON.stringify(first.tools ?? []), 'utf8'),
      firstPrompt: perStep[0]?.prompt ?? 0,
      prompt: perStep.reduce((total, step) => total + step.prompt, 0),
      cached: perStep.reduce((total, step) => total + step.cached, 0),
      completion: perStep.reduce((total, step) => total + step.completion, 0),
      reasoning: perStep.reduce((total, step) => total + step.reasoning, 0),
      seconds: seconds(wall),
      prefix: prefixKept(proxy.steps),
      ...(await enginePrefix(proxy.steps).then(engine => (engine === undefined ? {} : { engine }))),
      perStep,
    }
  } finally {
    await proxy.close()
  }
}

const model = await servedModel()
console.log(`measure-local-profile · ${model} at ${baseUrl} · build ${distPath} · arms ${arms.join(',')} · runs ${runs}`)
const results: ArmResult[] = []
for (let run = 1; run <= runs; run++) {
  const order = run % 2 === 1 ? arms : [...arms].reverse()
  for (const arm of order) {
    console.log(`  run ${run} · profile ${arm} …`)
    const result = await measureArm(model, arm, run)
    results.push(result)
    console.log(`  run ${run} · profile ${arm}: ${result.completed ? 'completed' : 'not completed'} in ${result.steps} steps, ${result.seconds} s`)
  }
}

const enginePrefixCell = (result: ArmResult): string => result.engine === undefined ? 'n/a' : `${result.engine.intact}/${result.engine.of} · ${result.engine.prompt > 0 ? Math.round((result.engine.common / result.engine.prompt) * 100) : 0}%`
const rows = results.map(result => `| ${result.model} | ${result.arm} | ${result.run} | ${result.completed ? 'yes' : 'no'} | ${result.steps} | ${result.toolCalls} | ${result.toolErrors} | ${result.firstSystemBytes.toLocaleString('en-US')} / ${result.firstToolBytes.toLocaleString('en-US')} | ${result.firstPrompt.toLocaleString('en-US')} | ${result.prompt.toLocaleString('en-US')} | ${result.cached.toLocaleString('en-US')} | ${result.completion.toLocaleString('en-US')} | ${result.reasoning.toLocaleString('en-US')} | ${result.seconds} | ${result.steps > 0 ? Math.round((result.seconds / result.steps) * 10) / 10 : 0} | ${result.prefix.kept}/${result.prefix.of} | ${enginePrefixCell(result)} |`)
console.log('')
console.log('| model | profile | run | task done | steps | tool calls | tool errors | step 1 system / tools (B) | step 1 prompt tok | prompt tok (all steps) | cached tok | completion tok | reasoning tok | seconds | s/step | prefix kept (bytes) | prefix kept (engine tokens) |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const row of rows) console.log(row)
console.log('')
console.log('| profile | run | step | crewmate | prompt | cached | completion | reasoning | seconds | ttft s | prefill s | tok/s |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const result of results) {
  for (const step of result.perStep) {
    console.log(`| ${result.arm} | ${result.run} | ${step.step} | ${step.crewmate ? 'yes' : ''} | ${step.prompt} | ${step.cached} | ${step.completion} | ${step.reasoning} | ${step.seconds} | ${step.ttft !== undefined ? Math.round(step.ttft * 100) / 100 : ''} | ${step.prefill !== undefined ? Math.round(step.prefill * 100) / 100 : ''} | ${step.tokensPerSecond !== undefined ? Math.round(step.tokensPerSecond) : ''} |`)
  }
}
for (const result of results) console.log(`\n${result.arm} run ${result.run}: outcome ${result.outcome}; check ${result.check}`)
mkdirSync(outDir, { recursive: true })
const file = join(outDir, `measure-local-profile-${model.replace(/[^a-zA-Z0-9.-]/g, '_')}.json`)
writeFileSync(file, `${JSON.stringify({ model, baseUrl, dist: distPath, task: TASK, results }, null, 2)}\n`)
console.log(`\nrecord: ${file}`)
process.exit(0)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printReport, readCapture, startTap } from './wire-prefix-replay.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DIST = path.join(REPO, 'dist', 'mercury.mjs')

const argv = process.argv.slice(2)
const argOf = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}
const MODEL = argOf('--model') ?? 'claude-sonnet-5'
const TAP = argv.includes('--tap')

const COST_LINE = `cost estimate (${MODEL}, ~7 requests, ~30k-token prefix): ≈ $0.15 with the prefix cached, ≈ $0.85 if every request re-bills it — list-rate arithmetic, check your own pricing`
console.log(COST_LINE)
if (process.env.MERCURY_WIRE_TRUTH_LIVE !== '1') {
  console.log('refusing to run: set MERCURY_WIRE_TRUTH_LIVE=1 to spend real credit on this session (a real key from ANTHROPIC_API_KEY or your own sign-in)')
  process.exit(2)
}
if (!existsSync(DIST)) {
  console.log('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const env: NodeJS.ProcessEnv = { ...process.env }
delete env.NODE_ENV
let homeNote: string
if (env.ANTHROPIC_API_KEY) {
  const home = mkdtempSync(path.join(tmpdir(), 'wire-truth-live-'))
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  env.MERCURY_CONFIG_DIR = path.join(home, '.claude')
  env.MERCURY_CREDENTIAL_STORE = 'file'
  env.HOME = home
  homeNote = `ANTHROPIC_API_KEY from the environment; scratch config home ${env.MERCURY_CONFIG_DIR}`
} else {
  homeNote = `no ANTHROPIC_API_KEY: the product's own sign-in from ${env.MERCURY_CONFIG_DIR ?? '~/.mercury'} (the session this run writes is titled "wire truth live" — delete it afterwards if you like)`
}
console.log(homeNote)

let tapHandle: { port: number; close(): void } | null = null
let captureFile: string | null = null
if (TAP) {
  captureFile = path.join(mkdtempSync(path.join(tmpdir(), 'wire-truth-tap-')), 'wire-capture.jsonl')
  writeFileSync(captureFile, '')
  tapHandle = await startTap({ out: captureFile, upstream: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com' })
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${tapHandle.port}`
  env.MERCURY_THINKING_BINDING = env.MERCURY_THINKING_BINDING ?? 'drop_block'
  env.MERCURY_TOOL_SEARCH = env.MERCURY_TOOL_SEARCH ?? 'on'
  console.log(`recording tap on ${env.ANTHROPIC_BASE_URL}; bodies land in ${captureFile}`)
}

interface Usage { input: number; cacheRead: number; cacheCreation: number; output: number }
interface RequestRow { id: string; turn: string; model: string; usage: Usage; drops: number; stopReason: string | null }
interface RunResult { exit: number | null; stdout: string; stderr: string; rows: RequestRow[] }

const j = (v: unknown): string => JSON.stringify(v)
const SID = `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`
const seenMessageIds = new Set<string>()

function rowsOf(stdout: string, turnLabel: (index: number) => string): RequestRow[] {
  const rows: RequestRow[] = []
  for (const line of stdout.split('\n')) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const envelope = JSON.parse(line) as { type?: string; message?: { id?: string; model?: string; usage?: Record<string, number>; stop_reason?: string | null; input_transformations?: unknown[] } }
      if (envelope.type !== 'assistant' || !envelope.message?.id) continue
      const id = envelope.message.id
      if (seenMessageIds.has(id)) continue
      seenMessageIds.add(id)
      const u = envelope.message.usage ?? {}
      rows.push({
        id,
        turn: turnLabel(rows.length),
        model: String(envelope.message.model ?? ''),
        usage: { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 },
        drops: Array.isArray(envelope.message.input_transformations) ? envelope.message.input_transformations.length : 0,
        stopReason: envelope.message.stop_reason ?? null,
      })
    } catch {
    }
  }
  return rows
}

function runStreaming(args: string[], prompts: string[], debugFile: string): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const child = spawn('node', [DIST, ...args, '--debug-file', debugFile], { env, cwd: REPO })
    let stdout = ''
    let stderr = ''
    let sent = 0
    let resultsSeen = 0
    const sendNext = (): void => {
      if (sent >= prompts.length) {
        child.stdin.end()
        return
      }
      const prompt = prompts[sent]!
      sent++
      child.stdin.write(j({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
    }
    child.stdout.on('data', d => {
      stdout += d
      const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
      while (resultsSeen < results) {
        resultsSeen++
        sendNext()
      }
    })
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolvePromise({ exit, stdout, stderr, rows: [] })
    })
    child.on('spawn', () => sendNext())
  })
}

const common = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--allowedTools', 'ToolSearch,WebFetch']
const scratch = mkdtempSync(path.join(tmpdir(), 'wire-truth-live-logs-'))
const debugA = path.join(scratch, 'a.debug.log')
const debugB = path.join(scratch, 'b.debug.log')

console.log(`\nsession ${SID} on ${MODEL}: three turns born in apollo, then two more resumed in flow`)
const a = await runStreaming(['--session-id', SID, '--permission-mode', 'apollo', ...common], [
  'wire truth live. Reply with exactly the word ALPHA and nothing else.',
  'Use the ToolSearch tool once with the query select:WebFetch to load the WebFetch tool, then reply with exactly LOOKUP-DONE and nothing else. Do not call any other tool.',
  'Reply with exactly the word GAMMA and nothing else.',
])
const rowsA = rowsOf(a.stdout, i => ['t1', 't2 (lookup call)', 't2 (after the lookup)', 't3'][i] ?? `a${i + 1}`)
console.log(`process A exit ${a.exit}; ${rowsA.length} request(s)${a.exit !== 0 ? ` stderr: ${a.stderr.slice(0, 300)}` : ''}`)

let switchedTo = 'flow'
let b = await runStreaming(['--resume', SID, '--permission-mode', 'flow', ...common], [
  'Reply with exactly the word DELTA and nothing else.',
  'Reply with exactly the word EPSILON and nothing else.',
])
if (b.exit !== 0 || !b.stdout.includes('"type":"result"')) {
  console.log(`flow was refused headless (exit ${b.exit}: ${b.stderr.slice(0, 200)}); switching to implement instead`)
  switchedTo = 'implement'
  b = await runStreaming(['--resume', SID, '--permission-mode', 'implement', ...common], [
    'Reply with exactly the word DELTA and nothing else.',
    'Reply with exactly the word EPSILON and nothing else.',
  ])
}
const rowsB = rowsOf(b.stdout, i => [`t4 (mode → ${switchedTo})`, 't5'][i] ?? `b${i + 1}`)
console.log(`process B exit ${b.exit}; ${rowsB.length} request(s)${b.exit !== 0 ? ` stderr: ${b.stderr.slice(0, 300)}` : ''}`)

const rows = [...rowsA, ...rowsB]
console.log('\nrequest  turn                     input  cache_read  cache_creation  drops  verdict')
let previousSize = 0
let heldPairs = 0
let brokePairs = 0
rows.forEach((row, index) => {
  const size = row.usage.input + row.usage.cacheRead + row.usage.cacheCreation
  let verdict = 'first request (nothing to hold yet)'
  if (index > 0) {
    const held = row.usage.cacheRead >= previousSize
    if (held) heldPairs++
    else brokePairs++
    verdict = held ? 'HELD (cache_read ≥ previous input)' : `BROKE (cache_read ${row.usage.cacheRead} < previous input ${previousSize})`
  }
  console.log(`#${String(index + 1).padEnd(7)} ${row.turn.padEnd(24)} ${String(row.usage.input).padStart(6)}  ${String(row.usage.cacheRead).padStart(10)}  ${String(row.usage.cacheCreation).padStart(14)}  ${String(row.drops).padStart(5)}  ${verdict}`)
  previousSize = size
})
const word = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(l => l.includes('preserved thinking:') || l.includes('[PROMPT CACHE BREAK]'))
  } catch {
    return []
  }
}
const words = [...word(debugA), ...word(debugB)]
console.log(`\nthe product's own word: ${words.length} line(s)`)
for (const line of words) console.log(`  ${line.slice(0, 300)}`)
console.log(`\nground truth: ${heldPairs} pair(s) held on Anthropic's side, ${brokePairs} broke (the mode switch pair is #${rowsA.length}→#${rowsA.length + 1})`)
console.log(`replies: ${['ALPHA', 'LOOKUP-DONE', 'GAMMA'].map(w => `${w}=${a.stdout.includes(w)}`).join(' ')} ${['DELTA', 'EPSILON'].map(w => `${w}=${b.stdout.includes(w)}`).join(' ')}`)

if (tapHandle !== null && captureFile !== null) {
  console.log(`\nthe bytes (recording tap): ${captureFile}`)
  printReport(readCapture(captureFile))
  tapHandle.close()
}
process.exit(a.exit === 0 && b.exit === 0 ? 0 : 1)

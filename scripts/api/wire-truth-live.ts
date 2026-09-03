#!/usr/bin/env bun
// ============================================================================
//  scripts/api/wire-truth-live.ts — the sent prefix on the REAL Anthropic
//  wire (opt-in, never enrolled, costs money).
//
//  The ground truth no fixture can give: Anthropic's own prompt cache. A
//  request whose prefix is byte-identical to the previous request's reads
//  that prefix from the cache — usage.cache_read_input_tokens comes back at
//  least the previous request's input size. A rewrite of sent history reads
//  0 (or far less) and, on Claude Fable 5.1, drops the bound thinking.
//
//  What it runs: a five-turn session on a cheap model (claude-sonnet-5 by
//  default) through the BUILT bundle's headless road, with ONE tool lookup
//  (the model loads a deferred tool through ToolSearch) and ONE mode switch
//  (the session is born in apollo and resumed in flow — implement when flow
//  is unavailable headless), reading the usage of every request off the
//  stream-json envelopes and the product's own drop word off its debug log.
//
//  Refuses to run without MERCURY_WIRE_TRUTH_LIVE=1 and prints its cost
//  estimate first. The lead or the operator runs it; a credential comes
//  from the environment (ANTHROPIC_API_KEY ⇒ a scratch config home) or the
//  operator's own sign-in (no key ⇒ the operator's config home is used as
//  is, and the session it writes is named so it can be deleted).
//
//    MERCURY_WIRE_TRUTH_LIVE=1 ~/.bun/bin/bun run scripts/api/wire-truth-live.ts [--model claude-sonnet-5] [--tap]
//
//  --tap also records every request body through the replay tool's
//  recording tap (scripts/api/wire-prefix-replay.ts) and prints the byte
//  path of every prefix move beside the usage table. The tap sits between
//  the product and api.anthropic.com, so the product no longer sees the
//  first-party host: the two explicit values it then needs to keep the wire
//  identical (MERCURY_THINKING_BINDING=drop_block, MERCURY_TOOL_SEARCH=on)
//  are set for you.
// ============================================================================
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

// ── the refusal and the cost ───────────────────────────────────────────────
// Seven requests (five turns, one tool round's second call, one resume);
// the prefix — system prompt and tool schemas — is roughly 25–40k tokens.
// At Sonnet-class list rates (input $3/M, output $15/M, cache write 1.25×,
// cache read 0.1×): every prefix cached ⇒ about $0.15; nothing cached ⇒
// about $0.85. The estimate is a list-rate arithmetic, not a quote.
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

// ── the credential and the home ────────────────────────────────────────────
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

// ── the headless road ──────────────────────────────────────────────────────
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
      // not an envelope
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

// ── the table ──────────────────────────────────────────────────────────────
const rows = [...rowsA, ...rowsB]
console.log('\nrequest  turn                     input  cache_read  cache_creation  drops  verdict')
let previousSize = 0
let heldPairs = 0
let brokePairs = 0
rows.forEach((row, index) => {
  const size = row.usage.input + row.usage.cacheRead + row.usage.cacheCreation
  let verdict = 'first request (nothing to hold yet)'
  if (index > 0) {
    // Anthropic's own reading: the prefix held when this request read at
    // least the previous request's whole input back from the cache.
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

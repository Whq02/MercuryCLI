#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { repeatOf, roads, serveRoad, writeProject, type Repeat, type Road, type Seen, type Step } from './turnCostFixture.ts'

type Prompt = { label: string; ask: string; steps: Step[] }
type Usage = { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number }
type Row = { type?: string; state?: string; timestamp?: string; usage?: Usage }
type Leaving = { beforeMs: number; toolMs: number; firstByteMs: number; said: Usage }
type Turn = Repeat & Leaving & { road: string; prompt: string; n: number; bootMs: number; wireBytes: number }
type Ran = { turns: Turn[]; seen: Seen[]; sides: number; codes: Array<number | null>; output: string }

const root = resolve(import.meta.dirname, '../..')
const dist = process.env.MERCURY_PROOF_DIST ?? join(root, 'dist/mercury.mjs')
const flagValue = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const outDir = flagValue('--out')
const weight = Number(flagValue('--weight') ?? '0')
const onlyRoad = flagValue('--road')
const profiled = process.argv.includes('--profile')
const moving = process.argv.includes('--cd')
const FOLD_ASK = 'Write the running record of this conversation'
const FOLD_ANSWER = Array.from({ length: 10 }, (_, index) => `${index + 1}. The sum project: its test failed, the fault is in src/sum.js, the work goes on from here.`).join('\n')
const extraEnv = Object.fromEntries(process.argv.flatMap((flag, index) => (flag === '--env' ? [(process.argv[index + 1] ?? '=').split('=', 2)] : [])))

function prompts(work: string): Prompt[] {
  const source = join(work, 'src', 'sum.js')
  const test = join(work, 'test', 'sum.test.js')
  return [
    {
      label: 'A',
      ask: 'The test in test/sum.test.js fails. Read the project, find the fault in src/sum.js, mend it and run the test until it passes.',
      steps: [
        ...Array.from({ length: weight }, (_, index): Step => ({ name: 'Read', input: { file_path: join(work, 'docs', `part-${index}.md`) } })),
        { name: 'Read', input: { file_path: join(work, 'package.json') } },
        { name: 'Read', input: { file_path: source } },
        { name: 'Read', input: { file_path: test } },
        { name: 'ToolSearch', input: { query: 'select:Test' } },
        ...(moving ? [{ name: 'Bash', input: { command: 'cd src && ls' } }, { name: 'Bash', input: { command: 'pwd' } }] : []),
        { name: 'Grep', input: { pattern: 'sum', path: join(work, 'src'), output_mode: 'content' } },
        { name: 'Bash', input: { command: 'node --test' } },
        { name: 'Edit', input: { file_path: source, old_string: 'return a - b', new_string: 'return a + b + 1' } },
        { name: 'Bash', input: { command: 'node --test' } },
        { name: 'Read', input: { file_path: source } },
        { name: 'Edit', input: { file_path: source, old_string: 'return a + b + 1', new_string: 'return a + b' } },
        { name: 'Bash', input: { command: 'node --test' } },
        { name: 'Glob', input: { pattern: '**/*.js', path: work } },
        { say: 'The sum function adds again and its test passes.' },
      ],
    },
    {
      label: 'B',
      ask: 'Add a second test for negative numbers and run the tests.',
      steps: [
        { name: 'Read', input: { file_path: test } },
        { name: 'Edit', input: { file_path: test, old_string: "assert.equal(sum(2, 3), 5)\n})", new_string: "assert.equal(sum(2, 3), 5)\n})\n\ntest('sum adds negatives', () => {\n  assert.equal(sum(-2, -3), -5)\n})" } },
        { name: 'Bash', input: { command: 'node --test' } },
        { say: 'A second test covers negative numbers and both pass.' },
      ],
    },
  ]
}

function leavings(lines: string[]): { startedMs: number | undefined; left: Leaving[] } {
  const left: Leaving[] = []
  let startedMs: number | undefined
  let sinceMs: number | undefined
  let calledMs: number | undefined
  let toolMs = 0
  let open: Leaving | undefined
  let leftMs = 0
  for (const line of lines) {
    const row = JSON.parse(line) as Row
    const atMs = row.timestamp === undefined ? NaN : Date.parse(row.timestamp)
    if (row.type === 'turn' && startedMs === undefined) {
      startedMs = atMs
      sinceMs = atMs
    } else if (row.type === 'wait' && row.state === 'first_byte' && sinceMs !== undefined) {
      open = { beforeMs: atMs - sinceMs, toolMs, firstByteMs: 0, said: {} }
      left.push(open)
      leftMs = atMs
      sinceMs = undefined
    } else if (row.type === 'wait' && row.state === 'done' && open !== undefined) {
      open.firstByteMs = atMs - leftMs
      open = undefined
    } else if (row.type === 'step') {
      const last = left.at(-1)
      if (last !== undefined && row.usage !== undefined) last.said = row.usage
    } else if (row.type === 'tool_call') {
      calledMs = atMs
    } else if (row.type === 'tool_result') {
      toolMs = atMs - (calledMs ?? atMs)
      sinceMs = atMs
    }
  }
  return { startedMs, left }
}

async function runRoad(road: Road, scratch: string): Promise<Ran> {
  const home = join(scratch, `${road.name}-home`)
  const work = join(scratch, `${road.name}-project`)
  mkdirSync(home, { recursive: true })
  writeProject(work, weight)
  const turns: Turn[] = []
  const codes: Array<number | null> = []
  let output = ''
  let current: Prompt | undefined
  let answered = 0
  const api = await serveRoad(
    road,
    body => {
      if (current === undefined) return undefined
      if (JSON.stringify(road.rows(body).at(-1) ?? null).includes(FOLD_ASK)) return { prompt: 'fold', step: { say: FOLD_ANSWER } }
      return { prompt: current.label, step: current.steps[answered++] ?? { say: 'Nothing is left to do.' } }
    },
    Date.now,
    (body, n) => { if (outDir !== undefined) writeFileSync(join(outDir, `${road.name}-side-${n}.json`), JSON.stringify(body, null, 1)) },
  )
  for (const prompt of prompts(work)) {
    current = prompt
    answered = 0
    const firstSeen = api.seen.length
    const lines: string[] = []
    const logged = outDir === undefined ? [] : ['--log-file', join(outDir, `${road.name}-${prompt.label}-debug.log`)]
    const profile = profiled && outDir !== undefined ? ['--cpu-prof', '--cpu-prof-dir', join(outDir, `profile-${road.name}-${prompt.label}`)] : []
    const spawnedMs = Date.now()
    const child = spawn('node', [...profile, dist, 'run', ...(prompt.label === 'A' ? [] : ['-c']), '--format', 'rows', '--model', road.model, '--mode', 'flow', ...logged, '-'], {
      cwd: work,
      env: { HOME: home, PATH: process.env.PATH ?? '', SHELL: process.env.SHELL ?? '/bin/sh', TERM: 'dumb', TMPDIR: scratch, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ...road.env(api.base), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(prompt.ask)
    let pending = ''
    child.stdout.on('data', data => {
      pending += String(data)
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const text of parts) if (text.trim().startsWith('{')) lines.push(text)
    })
    child.stderr.on('data', data => { output += String(data) })
    codes.push(await new Promise<number | null>((done, fail) => { child.on('error', fail); child.on('exit', done) }))
    current = undefined
    if (outDir !== undefined) writeFileSync(join(outDir, `${road.name}-${prompt.label}-rows.jsonl`), `${lines.join('\n')}\n`)
    const { startedMs, left } = leavings(lines)
    let timed = 0
    api.seen.slice(firstSeen).forEach((row, index) => {
      const leaving = row.prompt === 'fold' ? undefined : left[timed++]
      turns.push({
        road: road.name,
        prompt: row.prompt,
        n: row.n,
        bootMs: index === 0 ? (startedMs ?? spawnedMs) - spawnedMs : 0,
        beforeMs: leaving?.beforeMs ?? -1,
        toolMs: leaving?.toolMs ?? 0,
        firstByteMs: leaving?.firstByteMs ?? -1,
        said: leaving?.said ?? {},
        wireBytes: row.wireBytes,
        ...repeatOf(road, api.seen[row.n - 2], row),
      })
    })
  }
  await api.close()
  if (outDir !== undefined) api.seen.forEach(row => writeFileSync(join(outDir, `${road.name}-request-${String(row.n).padStart(2, '0')}.json`), JSON.stringify(row.body, null, 1)))
  return { turns, seen: api.seen, sides: api.sides(), codes, output }
}

if (!existsSync(dist)) {
  console.log(`FAIL ${dist} is missing: run bun run build.ts first, this table is measured on the built bundle`)
  process.exit(1)
}
if (outDir !== undefined) mkdirSync(outDir, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'turn-cost-'))
let failures = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
const header = ['road', 'prompt', 'request', 'ms_process_start_to_turn', 'ms_before_request_leaves', 'ms_tool_before_it', 'ms_to_first_byte', 'wire_bytes', 'bytes_before_conversation', 'cache_order_bytes', 'bytes_shared_with_last', 'share_of_request', 'bytes_of_last_lost', 'broke_at', 'tool_list_grew', 'fields_that_moved', 'said_input_tokens', 'said_cached_tokens', 'said_cache_write_tokens']
const table: string[] = [header.join('\t')]
const expected = 17 + weight + (moving ? 2 : 0)
try {
  for (const road of roads.filter(candidate => onlyRoad === undefined || candidate.name === onlyRoad)) {
    const ran = await runRoad(road, scratch)
    console.log(`\n${road.name}: ${ran.seen.length} requests, ${ran.sides} side requests, exits ${ran.codes.join(' ')}`)
    check(`${road.name}: both runs ended clean`, ran.codes.every(code => code === 0), ran.output.slice(-600))
    const asked = ran.turns.filter(turn => turn.prompt !== 'fold')
    check(`${road.name}: the task took its ${expected} requests`, asked.length === expected, `${asked.length} requests`)
    check(`${road.name}: every request's leaving was timed`, asked.every(turn => turn.beforeMs >= 0), 'a request has no wait row of its own')
    for (const turn of ran.turns) {
      table.push([turn.road, turn.prompt, turn.n, turn.bootMs, turn.beforeMs, turn.toolMs, turn.firstByteMs, turn.wireBytes, turn.headBytes, turn.cacheBytes, turn.sharedBytes, turn.cacheBytes === 0 ? '0' : (turn.sharedBytes / turn.cacheBytes).toFixed(3), turn.lostBytes, turn.brokeAt, turn.toolsGrew ? 'yes' : '', turn.moved, turn.said.input_tokens ?? '', turn.said.cached_input_tokens ?? '', turn.said.cache_write_input_tokens ?? ''].join('\t'))
    }
    const grown = ran.turns.filter(turn => turn.lostBytes > 0 && turn.brokeAt === 'tools' && turn.toolsGrew)
    const folded = ran.turns.filter((turn, index) => turn.lostBytes > 0 && ran.turns[index - 1]?.prompt === 'fold')
    for (const turn of folded) console.log(`  [NOTE] ${road.name}: request ${turn.n} follows a fold: it kept ${turn.sharedBytes} bytes of the request before it and sent ${turn.cacheBytes - turn.sharedBytes} new ones (first change at ${turn.brokeAt})`)
    const rewritten = ran.turns.filter(turn => turn.lostBytes > 0 && !grown.includes(turn) && !folded.includes(turn))
    for (const turn of grown) console.log(`  [NOTE] ${road.name}: request ${turn.n} sent a longer tool list, so the ${turn.lostBytes} bytes of conversation behind it could not be read from a cache`)
    check(`${road.name}: no request rewrites what the one before it sent, in the order a cache reads`, rewritten.length === 0, rewritten.map(turn => `request ${turn.n} (prompt ${turn.prompt}) lost ${turn.lostBytes} bytes at ${turn.brokeAt}`).join('; '))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${table.join('\n')}`)
if (outDir !== undefined) writeFileSync(join(outDir, 'TURNS.tsv'), `${table.join('\n')}\n`)
console.log(failures === 0 ? '\nPASS the turn cost table' : `\nFAIL ${failures} checks`)
process.exit(failures === 0 ? 0 : 1)

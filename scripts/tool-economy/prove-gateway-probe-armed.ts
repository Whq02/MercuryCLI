#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type CapturedRequest, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}
console.log(`build under proof: ${dist}`)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5'
const PROBE_TOOL = 'deferral_probe'
const PROBE_MARK = `"name":"${PROBE_TOOL}"`
const BLOCK_HEADER = 'advanced-tool-use-2025-11-20'
const STORE = 'tool-deferral-probe.json'
const world = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-probe-')))

type WireTool = { name?: unknown; defer_loading?: unknown }
type Shape = { tools: number; sha: string; deferred: number; toolSearch: boolean; blockHeader: boolean }
type Ran = { code: number | null; status: unknown; probes: CapturedRequest[]; turns: Shape[]; store: Record<string, { verdict?: string; status?: number | null }> | null; err: string }

const toolsOf = (request: CapturedRequest): WireTool[] => {
  const tools = (request.body as { tools?: unknown } | null)?.tools
  return Array.isArray(tools) ? (tools as WireTool[]) : []
}
const isProbe = (request: CapturedRequest): boolean => toolsOf(request).some(tool => tool.name === PROBE_TOOL)
const shapeOf = (request: CapturedRequest): Shape => {
  const tools = toolsOf(request)
  return {
    tools: tools.length,
    sha: createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16),
    deferred: tools.filter(tool => tool.defer_loading === true).length,
    toolSearch: tools.some(tool => tool.name === 'ToolSearch'),
    blockHeader: (request.headers['anthropic-beta'] ?? '').includes(BLOCK_HEADER),
  }
}

const conversation = (model: string): ScriptedTurn[] => [
  { kind: 'tool_use', name: 'Bash', input: { command: 'echo one', description: 'the first step' }, whenModel: model },
  { kind: 'tool_use', name: 'Bash', input: { command: 'echo two', description: 'the second step' }, whenModel: model },
  { kind: 'text', text: 'Both steps ran.', whenModel: model },
]
const honoured: ScriptedTurn = { kind: 'text', text: 'ok', whenBody: PROBE_MARK }
const shapeRefused: ScriptedTurn = { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'tools.0.defer_loading: Extra inputs are not permitted', whenBody: PROBE_MARK }
const keyRefused: ScriptedTurn = { kind: 'error', status: 401, errorType: 'authentication_error', message: 'invalid x-api-key', whenBody: PROBE_MARK }

type Gateway = { home: string; cwd: string; api: FixtureApi; seen: number }

async function gateway(name: string, runs: number, probeAnswer: ScriptedTurn | null, model: string = SONNET): Promise<Gateway> {
  const home = join(world, name, 'home')
  const cwd = join(world, name, 'project')
  mkdirSync(join(home, 'tmp'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const script: ScriptedTurn[] = []
  for (let run = 0; run < runs; run++) {
    if (probeAnswer !== null) script.push(probeAnswer)
  }
  for (let run = 0; run < runs; run++) script.push(...conversation(model))
  return { home, cwd, api: await startFixtureApi(script, { jsonForNonStream: true }), seen: 0 }
}

function mercuryRun(at: Gateway, env: Record<string, string>, flags: string[] = [], model: string = SONNET): Promise<Ran> {
  const child = spawn('node', [dist, 'run', '--mode', 'sovereign', '--model', model, '--format', 'json', ...flags, '--', 'Run the two steps.'], {
    cwd: at.cwd,
    env: {
      HOME: at.home,
      PATH: process.env.PATH ?? '',
      TMPDIR: join(at.home, 'tmp'),
      MERCURY_TMPDIR: join(at.home, 'tmp'),
      MERCURY_CONFIG_DIR: at.home,
      MERCURY_HOME: at.home,
      MERCURY_DAEMON_DIR: join(at.home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: at.api.url,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => {
    out += String(chunk)
  })
  child.stderr.on('data', chunk => {
    err += String(chunk)
  })
  const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
  return new Promise<Ran>(done =>
    child.on('close', code => {
      clearTimeout(guard)
      const all = at.api.messageRequests()
      const mine = all.slice(at.seen)
      at.seen = all.length
      let status: unknown
      try {
        status = (JSON.parse(out.trim().split('\n').at(-1) ?? 'null') as { status?: unknown } | null)?.status
      } catch {
        status = out.slice(0, 200)
      }
      const storePath = join(at.home, STORE)
      let store: Ran['store'] = null
      if (existsSync(storePath)) {
        try {
          store = (JSON.parse(readFileSync(storePath, 'utf8')) as { hosts?: Ran['store'] }).hosts ?? {}
        } catch {
          store = {}
        }
      }
      done({ code, status, probes: mine.filter(isProbe), turns: mine.filter(request => !isProbe(request)).map(shapeOf), store, err })
    }),
  )
}

const ARMED = { MERCURY_TOOL_DEFER_PROBE: '1' }
const completed = (ran: Ran): boolean => ran.code === 0 && ran.status === 'completed' && ran.turns.length === 3
const whole = (ran: Ran, sha: string): boolean => ran.turns.every(turn => turn.sha === sha && turn.deferred === 0 && !turn.toolSearch && !turn.blockHeader)
const hostOf = (at: Gateway): string => new URL(at.api.url).host

section('§1 UNARMED — a gateway nobody probed: every definition whole, no request beside the conversation, nothing kept')
const plain = await gateway('unarmed', 1, null)
const unarmed = await mercuryRun(plain, {})
await plain.api.close()
const wholeSha = unarmed.turns[0]?.sha ?? ''
check('the run completed in three model calls', completed(unarmed), j({ code: unarmed.code, status: unarmed.status, turns: unarmed.turns.length, err: unarmed.err.slice(-300) }))
check('no probe request went out', unarmed.probes.length === 0, j(unarmed.probes.length))
check('no verdict file was written', unarmed.store === null, j(unarmed.store))
check('the three calls carry one tools array, nothing deferred, no ToolSearch, no block-form header', wholeSha !== '' && whole(unarmed, wholeSha), j(unarmed.turns))

section('§2 ARMED, the gateway honours the block form — one probe, its verdict kept, the next conversation defers')
{
  const at = await gateway('honoured', 2, honoured)
  const first = await mercuryRun(at, ARMED)
  const second = await mercuryRun(at, ARMED)
  await at.api.close()
  const probe = first.probes[0]
  const body = (probe?.body ?? {}) as { model?: unknown; max_tokens?: unknown; stream?: unknown; messages?: unknown[] }
  const probeTools = probe === undefined ? [] : toolsOf(probe)
  check('the first run completed in three model calls', completed(first), j({ code: first.code, status: first.status, turns: first.turns.length, err: first.err.slice(-300) }))
  check('exactly ONE probe request went out beside them', first.probes.length === 1, j(first.probes.length))
  check('the probe is the bounded shape: one output token, not streamed, one user turn, the run\'s own model', body.max_tokens === 1 && body.stream !== true && Array.isArray(body.messages) && body.messages.length === 1 && body.model === SONNET, j({ max_tokens: body.max_tokens, stream: body.stream, model: body.model }))
  check('…carrying one fixture tool marked defer_loading under the block-form header', probeTools.length === 1 && probeTools[0]!.defer_loading === true && (probe?.headers['anthropic-beta'] ?? '').includes(BLOCK_HEADER), j({ tools: probeTools, beta: probe?.headers['anthropic-beta'] }))
  check('the verdict file is written: block, for this gateway host', first.store?.[hostOf(at)]?.verdict === 'block' && first.store[hostOf(at)]!.status === 200, j(first.store))
  check('the conversation under way keeps the tool list it started with: all three calls byte for byte the unarmed array', whole(first, wholeSha), j(first.turns))
  check('the second run completed in three model calls', completed(second), j({ code: second.code, status: second.status, turns: second.turns.length, err: second.err.slice(-300) }))
  check('the second run sent NO probe (the verdict is kept)', second.probes.length === 0, j(second.probes.length))
  check('the second run rides the block form from its first call: definitions deferred, ToolSearch offered, the header sent', second.turns.every(turn => turn.deferred > 0 && turn.toolSearch && turn.blockHeader), j(second.turns))
  check('…and one tools array for the whole conversation', new Set(second.turns.map(turn => turn.sha)).size === 1 && second.turns[0]?.sha !== wholeSha, j(second.turns.map(turn => turn.sha)))
}

section('§3 ARMED, the gateway refuses the shape — one probe, the text verdict kept, every later call whole as before')
{
  const at = await gateway('refused', 2, shapeRefused)
  const first = await mercuryRun(at, ARMED)
  const second = await mercuryRun(at, ARMED)
  await at.api.close()
  check('both runs completed', completed(first) && completed(second), j({ first: [first.code, first.status, first.turns.length], second: [second.code, second.status, second.turns.length] }))
  check('the first run sent exactly one probe', first.probes.length === 1, j(first.probes.length))
  check('the verdict file is written: text, with the gateway\'s 400', first.store?.[hostOf(at)]?.verdict === 'text' && first.store[hostOf(at)]!.status === 400, j(first.store))
  check('the second run sent no probe', second.probes.length === 0, j(second.probes.length))
  check('both conversations carry the unarmed array: a refusing gateway is never sent a deferred definition', whole(first, wholeSha) && whole(second, wholeSha), j({ first: first.turns, second: second.turns }))
}

section('§4 ARMED, the gateway refuses the key — no verdict, so the next process asks once more')
{
  const at = await gateway('no-verdict', 2, keyRefused)
  const first = await mercuryRun(at, ARMED)
  const second = await mercuryRun(at, ARMED)
  await at.api.close()
  check('both runs completed', completed(first) && completed(second), j({ first: [first.code, first.status, first.turns.length], second: [second.code, second.status, second.turns.length] }))
  check('each run sent exactly one probe', first.probes.length === 1 && second.probes.length === 1, j([first.probes.length, second.probes.length]))
  check('no verdict was kept', first.store === null && second.store === null, j([first.store, second.store]))
  check('both conversations carry the unarmed array', whole(first, wholeSha) && whole(second, wholeSha), j({ first: first.turns, second: second.turns }))
}

section('§5 ARMED where a probe could decide nothing — no request is spent')
{
  const quiet = await gateway('quiet-traffic', 1, honoured)
  const posture = await mercuryRun(quiet, { ...ARMED, MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  await quiet.api.close()
  check('the non-essential-traffic posture keeps the probe off', posture.code === 0 && posture.probes.length === 0 && posture.store === null, j({ code: posture.code, probes: posture.probes.length, store: posture.store }))

  const small = await gateway('no-references', 1, honoured, HAIKU)
  const haiku = await mercuryRun(small, ARMED, [], HAIKU)
  await small.api.close()
  check('a model that takes no tool references never carries the probe', haiku.code === 0 && haiku.turns.length === 3 && haiku.probes.length === 0 && haiku.store === null, j({ code: haiku.code, turns: haiku.turns.length, probes: haiku.probes.length, store: haiku.store }))

  const off = await gateway('deferral-off', 1, honoured)
  const standard = await mercuryRun(off, { ...ARMED, MERCURY_TOOL_DEFER: '0' })
  await off.api.close()
  check('deferral switched off sends no probe', standard.code === 0 && standard.turns.length === 3 && standard.probes.length === 0 && standard.store === null, j({ code: standard.code, turns: standard.turns.length, probes: standard.probes.length, store: standard.store }))

  const six = await gateway('six-tools', 1, honoured)
  const narrow = await mercuryRun(six, ARMED, ['--toolset', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'])
  await six.api.close()
  check('a tool list without ToolSearch sends no probe', narrow.code === 0 && narrow.turns.length === 3 && narrow.turns.every(turn => !turn.toolSearch) && narrow.probes.length === 0 && narrow.store === null, j({ code: narrow.code, turns: narrow.turns, probes: narrow.probes.length, store: narrow.store }))
}

rmSync(world, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.log('GATEWAY PROBE CALL SITE RED')
  process.exit(1)
}
console.log('GATEWAY PROBE CALL SITE GREEN')
process.exit(0)

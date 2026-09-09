#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const VENDORED_NODE = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (cond()) return true
    if (Date.now() > deadline) return false
    await wait(100)
  }
}

const ASK = 'controls-drive: launch the pair'
const FIXTURE_API_KEY = 'fixture-key-000'
const WF_NAME = 'controls-pair'
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'two agents that sleep until told', phases: [{ title: 'Hold' }] }`,
  "phase('Hold')",
  "const [a, b] = await parallel([() => agent('wf-agent: hold the alpha line', { label: 'alpha' }), () => agent('wf-agent: hold the beta line', { label: 'beta' })])",
  'return { a, b }',
].join('\n')

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
function answer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_ctl_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_ctl_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

function itemsOf(body: unknown): unknown[] {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? b.messages : []
}
function lastUserText(body: unknown): string {
  let last = ''
  for (const m of itemsOf(body)) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    let text = ''
    if (typeof msg.content === 'string') text = msg.content
    else if (Array.isArray(msg.content)) for (const block of msg.content as Array<{ type?: string; text?: string }>) if (block.type === 'text' && typeof block.text === 'string') text += `\n${block.text}`
    if (text.includes('wf-agent:') || text.includes('controls-drive:')) last = text
  }
  return last
}
function carriesToolResult(body: unknown): boolean {
  for (const m of itemsOf(body)) {
    const item = m as { role?: string; content?: unknown }
    if (item.role !== 'user' || !Array.isArray(item.content)) continue
    if ((item.content as Array<{ type?: string }>).some(b => b.type === 'tool_result')) return true
  }
  return false
}
function offersTool(body: unknown, name: string): boolean {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}

type Hit = { route: string; who: string | null; at: number }
async function startFixture(port: number): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  const t0 = Date.now()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const text = lastUserText(body)
      const ack = carriesToolResult(body)
      let blocks: Block[]
      let route: string
      let who: string | null = null
      if (text.includes('wf-agent:')) {
        who = text.includes('alpha') ? 'alpha' : 'beta'
        route = 'agent'
        blocks = [{ type: 'tool_use', name: 'Sleep', input: { seconds: 1 } }]
      } else if (text.includes('controls-drive:') && offersTool(body, 'Workflow')) {
        route = ack ? 'parent-ack' : 'parent'
        blocks = ack ? [{ type: 'text', text: 'controls-drive: the pair landed.' }] : [{ type: 'text', text: 'launching the pair' }, { type: 'tool_use', name: 'Workflow', input: { script: WF_SCRIPT } }]
      } else {
        route = 'side'
        blocks = [{ type: 'text', text: 'ok' }]
      }
      hits.push({ route, who, at: Date.now() - t0 })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks, { input: 60, output: 8 }))
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
interface Capture {
  text: string
  marks: Record<string, string>
  sends: number
  receipts: number
  endReason: string
}
function captureAsync(cfg: Record<string, unknown>, env: Record<string, string>): { done: Promise<Capture>; kill(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'wf-controls-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(280_000))
  child.stderr?.on('data', c => stderr.push(String(c)))
  const done = new Promise<Capture>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      if (!existsSync(outPath)) {
        reject(new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`))
        return
      }
      const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
      const marks: Record<string, string> = {}
      for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
      rmSync(dir, { recursive: true, force: true })
      resolve({ text: gridText(payload.grid), marks, sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '' })
    })
  })
  return { done, kill: () => child.kill('SIGKILL') }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wf-controls-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'wf-controls-cwd-')))
  seedFirstRun(home, [cwd])
  return { home, cwd }
}
function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
  { data: '\r', atTick: 999, awaitText: 'Yes, run this workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 6 },
]

function dump(label: string, frame: string | undefined, cols: number): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, cols)}`)
}
const KEEP = process.env.WF_CONTROLS_KEEP === '1'
const FRAMES_DIR = process.env.WF_CONTROLS_FRAMES
function saveFrames(tag: string, marks: Record<string, string>): void {
  if (FRAMES_DIR === undefined) return
  for (const [label, frame] of Object.entries(marks)) writeFileSync(join(FRAMES_DIR, `${tag}-${label}.txt`), frame + '\n')
}

function runDirsUnder(home: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (n.startsWith('wf_') && existsSync(join(p, 'run.json'))) out.push(p)
        else walk(p)
      }
    }
  }
  walk(join(home, 'projects'))
  return out
}
function manifestOf(runDir: string): { status: string; pausedBy?: string; endedBy?: string; controlVersion?: number; agents: Array<{ label: string; state: string; waiting?: string; pausedBy?: string; error?: string; endedBy?: string; agentId?: string }> } {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
}
function journalActs(runDir: string): string[] {
  const p = join(runDir, 'journal.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { type: string; request?: { action: string }; action?: string; result?: { outcome: string } })
    .filter(r => r.type === 'control-request' || r.type === 'control-result')
    .map(r => (r.type === 'control-request' ? `req:${r.request?.action}` : `res:${r.action}:${r.result?.outcome}`))
}
const rowOf = (text: string, needle: string): string | undefined => text.split('\n').filter(l => l.includes(needle)).at(-1)
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const LEG = process.env.WF_CONTROLS_LEG ?? 'all'
const runs = (leg: string): boolean => LEG === 'all' || LEG === leg
const PORT_BASE = Number(process.env.WF_CONTROLS_PORT ?? 25191)

async function viewLeg(cols: number, rows: number, port: number): Promise<void> {
  const tag = `views@${cols}`
  console.log(`\n— ${tag} —`)
  const before = failures
  const fixture = await startFixture(port)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await captureAsync(
      {
        cols,
        rows,
        total: 600,
        cwd,
        argv: [NODE, DIST],
        sends: [
          ...bootSends(ASK),
          { data: '/workflows', atTick: 999, awaitText: '2 running', requireAwait: true, minTick: 2, awaitSettleTicks: 6 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'Mercury — workflows', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board-active' },
          { data: '\r', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'x kill', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'run-running' },
          { data: 'p', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'p resumes it', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'run-alpha-paused' },
          { data: 'p', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'resumed by', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
          { data: '', atTick: 999, awaitText: 'x kill · p pause', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'run-alpha-resumed' },
          { data: '\x1b[B', afterPrevTicks: 2 },
          { data: 'x', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'killed by the operator', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'run-beta-killed' },
          { data: 'x', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'nothing to kill', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'run-beta-kill-refused' },
          { data: '\x1b', afterPrevTicks: 4 },
          { data: '', atTick: 999, awaitText: 'x stop', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board-before-stop' },
          { data: 'x', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'stopped by', requireAwait: true, minTick: 2, awaitSettleTicks: 12, mark: 'board-stopped' },
          { data: '\t', afterPrevTicks: 2 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'Mercury — run', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'run-settled' },
          { data: 'X', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'nothing to stop', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'run-stop-refused' },
          { data: '\x1b', afterPrevTicks: 4 },
          { data: '\x1b', afterPrevTicks: 3 },
          { data: '', afterPrevTicks: 4, mark: 'end' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
    ).done
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  if (KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, cols)
  saveFrames(tag, marks)
  check(`${tag}: every send became due`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const boardActive = marks['board-active'] ?? ''
  check(`${tag}: the board lists the run under Active with x stop and p pause in its footer`, /Active/.test(boardActive) && boardActive.includes(WF_NAME) && /x stop/.test(flat(boardActive)) && /p pause/.test(flat(boardActive)), flat(boardActive).slice(-300))
  const running = marks['run-running'] ?? ''
  check(`${tag}: the run view lists both lanes running and names every key it honours`, rowOf(running, 'alpha') !== undefined && rowOf(running, 'beta') !== undefined && /x kill · p pause · s skip · r retry · X stop · P pause run · S save · esc/.test(flat(running)), flat(running).slice(-400))
  const paused = marks['run-alpha-paused'] ?? ''
  check(`${tag}: p over alpha — its row reads paused by session …, the footer offers p resume`, /alpha.*paused by session/.test(flat(paused)) && /p resume ·/.test(flat(paused)), flat(paused).slice(-500))
  const resumed = marks['run-alpha-resumed'] ?? ''
  check(`${tag}: p again — alpha resumed in place, the footer offers p pause again`, !/alpha.*paused by/.test(flat(resumed)) && /x kill · p pause/.test(flat(resumed)), flat(resumed).slice(-500))
  const killed = marks['run-beta-killed'] ?? ''
  check(`${tag}: x over beta — its row reads killed by the operator; alpha still runs`, /✕ ✧ beta.*killed by the op/.test(flat(killed)) && /◐ ✧ alpha/.test(flat(killed)), flat(killed).slice(-500))
  const killRefused = marks['run-beta-kill-refused'] ?? ''
  check(`${tag}: x on the settled beta says why in one line`, /beta already settled — nothing to kill/.test(flat(killRefused)), flat(killRefused).slice(-300))
  const stopped = marks['board-stopped'] ?? ''
  check(`${tag}: x on the list stops the run — the note says stopped by session …`, /stopped by session/.test(flat(stopped)), flat(stopped).slice(-400))
  const settled = marks['run-settled'] ?? ''
  check(`${tag}: the settled run view reads killed · stopped by session …, its rows kept`, /killed/.test(flat(settled)) && /stopped by session/.test(flat(settled)) && rowOf(settled, 'alpha') !== undefined && rowOf(settled, 'beta') !== undefined, flat(settled).slice(-500))
  const stopRefused = marks['run-stop-refused'] ?? ''
  check(`${tag}: X on the settled run says already settled — nothing to stop`, /already settled — nothing to stop/.test(flat(stopRefused)), flat(stopRefused).slice(-300))
  const dirs = runDirsUnder(home)
  check(`${tag}: one run dir with run.json, journal, claim and the control records`, dirs.length === 1 && existsSync(join(dirs[0]!, 'journal.jsonl')) && existsSync(join(dirs[0]!, 'claim.json')) && existsSync(join(dirs[0]!, 'control')), dirs.join(','))
  if (dirs.length === 1) {
    const m = manifestOf(dirs[0]!)
    check(`${tag}: run.json reads killed, ended by the session, beta killed by the operator, alpha stopped`, m.status === 'killed' && /^session /.test(m.endedBy ?? '') && m.agents.some(a => a.label === 'beta' && a.error === 'killed by the operator' && a.endedBy === 'operator') && m.agents.some(a => a.label === 'alpha' && a.state === 'stopped'), JSON.stringify({ status: m.status, endedBy: m.endedBy, agents: m.agents.map(a => [a.label, a.state, a.error]) }))
    const acts = journalActs(dirs[0]!)
    check(`${tag}: the journal reads every act back in order — pause, resume, kill, stop (the refused kill never left the view)`, JSON.stringify(acts) === JSON.stringify(['req:pause-agent', 'res:pause-agent:applied', 'req:resume-agent', 'res:resume-agent:applied', 'req:kill-agent', 'res:kill-agent:applied', 'req:stop', 'res:stop:applied']), JSON.stringify(acts))
  }
  const agentHits = fixture.hits.filter(h => h.route === 'agent')
  check(`${tag}: both agents kept asking the wire (a Sleep per request) until the stop, and never answered on their own`, agentHits.filter(h => h.who === 'alpha').length >= 3 && agentHits.filter(h => h.who === 'beta').length >= 3, `alpha ${agentHits.filter(h => h.who === 'alpha').length} · beta ${agentHits.filter(h => h.who === 'beta').length}`)
  if (failures > before && !KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, cols)
  if (failures > before || KEEP) dump(`${tag} · final grid`, cap.text, cols)
  if (KEEP) console.log(`[keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function secondProcessLeg(port: number): Promise<void> {
  const tag = 'second-process'
  console.log(`\n— ${tag} —`)
  const before = failures
  const fixture = await startFixture(port)
  const { home, cwd } = seedWorld()
  const env = driveEnv(home, fixture.base)
  const cols = 120
  const rows = 40
  const first = captureAsync(
    {
      cols,
      rows,
      total: 700,
      cwd,
      argv: [NODE, DIST],
      sends: [
        ...bootSends(ASK),
        { data: '/workflows', atTick: 999, awaitText: '2 running', requireAwait: true, minTick: 2, awaitSettleTicks: 6 },
        { data: '\r', afterPrevTicks: 3 },
        { data: '', atTick: 999, awaitText: 'Mercury — workflows', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board-active' },
        { data: '', atTick: 999, awaitText: 'Recent (1)', requireAwait: true, minTick: 2, awaitSettleTicks: 6 },
        { data: '2', afterPrevTicks: 2 },
        { data: '', atTick: 999, awaitText: 'stopped by', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board-stopped-elsewhere' },
        { data: '\r', afterPrevTicks: 3 },
        { data: '', atTick: 999, awaitText: 'Mercury — run', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'run-stopped-elsewhere' },
        { data: '\x1b', afterPrevTicks: 3 },
        { data: '\x1b', afterPrevTicks: 3 },
        { data: '', afterPrevTicks: 4, mark: 'end' },
      ],
      stableTicks: 6,
    },
    env,
  )
  let second: Capture | null = null
  try {
    const launched = await until(() => runDirsUnder(home).some(d => manifestOf(d).agents.length === 2 && manifestOf(d).agents.every(a => a.state === 'progress' || a.state === 'start')), 120_000)
    check(`${tag}: the first process launched the pair (run.json lists both lanes in flight)`, launched)
    const runDir = runDirsUnder(home)[0]
    if (runDir !== undefined) {
      second = await captureAsync(
        {
          cols,
          rows,
          total: 260,
          cwd,
          argv: [NODE, DIST],
          sends: [
            { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
            { data: '/workflows', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
            { data: '\r', afterPrevTicks: 3 },
            { data: '', atTick: 999, awaitText: 'External (1)', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'second-board' },
            { data: '3', afterPrevTicks: 2 },
            { data: '', atTick: 999, awaitText: 'x stop', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'second-external-selected' },
            { data: 'x', afterPrevTicks: 2 },
            { data: '', atTick: 999, awaitText: 'stopped by', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'second-stopped' },
            { data: '\x1b', afterPrevTicks: 4 },
            { data: '', afterPrevTicks: 4, mark: 'end' },
          ],
          stableTicks: 6,
        },
        env,
      ).done
    }
  } finally {
    const firstCap = await first.done.catch(() => null)
    await fixture.close()
    if (firstCap !== null) {
      if (KEEP) for (const [label, frame] of Object.entries(firstCap.marks)) dump(`${tag} · first · ${label}`, frame, cols)
      saveFrames(`${tag}-first`, firstCap.marks)
      check(`${tag}: the first process's sends all became due`, firstCap.receipts === firstCap.sends, `${firstCap.receipts}/${firstCap.sends} · end ${firstCap.endReason}`)
      const stoppedElsewhere = firstCap.marks['board-stopped-elsewhere'] ?? ''
      check(`${tag}: the FIRST process's board reads the run stopped by the other session`, /stopped by session/.test(flat(stoppedElsewhere)) && /killed/.test(flat(stoppedElsewhere)), flat(stoppedElsewhere).slice(-400))
      if (failures > before && !KEEP) for (const [label, frame] of Object.entries(firstCap.marks)) dump(`${tag} · first · ${label}`, frame, cols)
      if (failures > before || KEEP) dump(`${tag} · first · final grid`, firstCap.text, cols)
    }
  }
  if (second !== null) {
    if (KEEP) for (const [label, frame] of Object.entries(second.marks)) dump(`${tag} · second · ${label}`, frame, cols)
    saveFrames(`${tag}-second`, second.marks)
    check(`${tag}: the second process's sends all became due`, second.receipts === second.sends, `${second.receipts}/${second.sends} · end ${second.endReason}`)
    const secondBoard = marksOr(second, 'second-external-selected')
    check(`${tag}: the second process's board lists the run as External (running elsewhere) with x stop · p pause armed`, /External/.test(secondBoard) && secondBoard.includes(WF_NAME) && /x stop/.test(flat(secondBoard)) && /p pause/.test(flat(secondBoard)), flat(secondBoard).slice(-400))
    const secondStopped = marksOr(second, 'second-stopped')
    check(`${tag}: x from the second process stops it — the note reads stopped by session …`, /stopped by session/.test(flat(secondStopped)), flat(secondStopped).slice(-400))
    if (failures > before && !KEEP) for (const [label, frame] of Object.entries(second.marks)) dump(`${tag} · second · ${label}`, frame, cols)
    if (failures > before || KEEP) dump(`${tag} · second · final grid`, second.text, cols)
  }
  const dirs = runDirsUnder(home)
  if (dirs.length === 1) {
    const m = manifestOf(dirs[0]!)
    check(`${tag}: run.json reads killed, ended by a session that is not the launcher's process`, m.status === 'killed' && /^session /.test(m.endedBy ?? ''), JSON.stringify({ status: m.status, endedBy: m.endedBy }))
    check(`${tag}: the stop is journaled by the run's launcher`, JSON.stringify(journalActs(dirs[0]!)) === JSON.stringify(['req:stop', 'res:stop:applied']), JSON.stringify(journalActs(dirs[0]!)))
  } else check(`${tag}: exactly one run dir`, false, dirs.join(','))
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
const marksOr = (c: Capture, label: string): string => c.marks[label] ?? ''

async function persistenceLeg(port: number): Promise<void> {
  const tag = 'persistence'
  console.log(`\n— ${tag} —`)
  const before = failures
  const fixture = await startFixture(port)
  const { home, cwd } = seedWorld()
  const cols = 120
  const rows = 40
  let cap: Capture | null = null
  try {
    cap = await captureAsync(
      {
        cols,
        rows,
        total: 900,
        cwd,
        argv: [NODE, DIST],
        sends: [
          ...bootSends(ASK),
          { data: '/workflows', atTick: 999, awaitText: '2 running', requireAwait: true, minTick: 2, awaitSettleTicks: 6 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'Mercury — workflows', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board-before-compact' },
          { data: '\x1b', afterPrevTicks: 3 },
          { data: '/compact', atTick: 999, awaitText: 'waiting on 1 workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'Compacted', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'after-compact' },
          { data: '/workflows', afterPrevTicks: 3 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'x stop', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board-after-compact' },
          { data: 'p', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'paused by', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'board-paused-after-compact' },
          { data: 'p', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'resumed by', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'board-resumed-after-compact' },
          { data: '\x1b', afterPrevTicks: 3 },
          { data: '/clear', atTick: 999, awaitText: 'waiting on 1 workflow', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', afterPrevTicks: 30, mark: 'after-clear' },
          { data: '/workflows', afterPrevTicks: 3 },
          { data: '\r', afterPrevTicks: 3 },
          { data: '', atTick: 999, awaitText: 'x stop', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'board-after-clear' },
          { data: 'x', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: 'stopped by', requireAwait: true, minTick: 2, awaitSettleTicks: 12, mark: 'board-stopped-after-clear' },
          { data: '\x1b', afterPrevTicks: 4 },
          { data: '', afterPrevTicks: 4, mark: 'end' },
        ],
        stableTicks: 6,
      },
      driveEnv(home, fixture.base),
    ).done
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  if (KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, cols)
  saveFrames(tag, marks)
  check(`${tag}: every send became due`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const afterCompact = marks['board-after-compact'] ?? ''
  check(`${tag}: after the compaction the board still lists the run with x stop · p pause armed`, afterCompact.includes(WF_NAME) && /x stop/.test(flat(afterCompact)) && /p pause/.test(flat(afterCompact)), flat(afterCompact).slice(-400))
  check(`${tag}: p after the compaction pauses the run the session launched`, /paused by session/.test(flat(marks['board-paused-after-compact'] ?? '')), flat(marks['board-paused-after-compact'] ?? '').slice(-300))
  check(`${tag}: p again resumes it`, /resumed by session/.test(flat(marks['board-resumed-after-compact'] ?? '')), flat(marks['board-resumed-after-compact'] ?? '').slice(-300))
  const afterClear = marks['board-after-clear'] ?? ''
  check(`${tag}: after the /clear the fresh chat's board still lists the run with x stop armed`, afterClear.includes(WF_NAME) && /x stop/.test(flat(afterClear)), flat(afterClear).slice(-400))
  check(`${tag}: x after the /clear stops the run the earlier chat launched`, /stopped by session/.test(flat(marks['board-stopped-after-clear'] ?? '')), flat(marks['board-stopped-after-clear'] ?? '').slice(-300))
  const dirs = runDirsUnder(home)
  if (dirs.length === 1) {
    const m = manifestOf(dirs[0]!)
    check(`${tag}: run.json reads killed and the journal carries pause, resume and stop`, m.status === 'killed' && JSON.stringify(journalActs(dirs[0]!)) === JSON.stringify(['req:pause', 'res:pause:applied', 'req:resume', 'res:resume:applied', 'req:stop', 'res:stop:applied']), `${m.status} ${JSON.stringify(journalActs(dirs[0]!))}`)
  } else check(`${tag}: exactly one run dir`, false, dirs.join(','))
  const agentHits = fixture.hits.filter(h => h.route === 'agent')
  check(`${tag}: both agents kept asking the wire through the compaction and the clear`, agentHits.filter(h => h.who === 'alpha').length >= 6 && agentHits.filter(h => h.who === 'beta').length >= 6, `alpha ${agentHits.filter(h => h.who === 'alpha').length} · beta ${agentHits.filter(h => h.who === 'beta').length}`)
  if (failures > before && !KEEP) for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame, cols)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

if (runs('views80')) await viewLeg(80, 36, PORT_BASE)
if (runs('views120')) await viewLeg(120, 40, PORT_BASE + 1)
if (runs('second')) await secondProcessLeg(PORT_BASE + 2)
if (runs('persistence')) await persistenceLeg(PORT_BASE + 3)

console.log(failures === 0 ? '\nprove-workflow-controls-drive: ALL LAWS HOLD' : `\nprove-workflow-controls-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

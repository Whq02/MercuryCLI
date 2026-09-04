#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DIST = path.join(REPO, 'dist', 'mercury.mjs')
const MODEL = 'claude-fable-5-1'

type Block = Record<string, unknown>
type Row = { role?: string; content?: unknown }
type WireBody = { model?: string; system?: unknown; tools?: unknown; messages?: unknown[]; thinking?: unknown }
type CaptureRow = { seq: number; at: number; model: string; body: WireBody; response: { status: number; drops: unknown[]; refusal: string | null; text: string } }

const j = (v: unknown): string => JSON.stringify(v)

function rowText(row: Row | undefined): string {
  if (row === undefined) return ''
  if (typeof row.content === 'string') return row.content
  if (!Array.isArray(row.content)) return ''
  return (row.content as Block[]).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => String(b.text)).join('\n')
}

async function serve(captureFile: string): Promise<void> {
  const fixture = await import('../lib/fixtureApi.ts')
  let seq = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(j({ data: [{ type: 'model', id: MODEL, display_name: 'Claude Fable 5.1', created_at: '2026-08-01T00:00:00Z' }], has_more: false }))
        return
      }
      if (url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(j({ input_tokens: 1000 }))
        return
      }
      if (!(req.method === 'POST' && url.includes('/messages'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: WireBody
      try {
        body = JSON.parse(raw) as WireBody
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(j({ type: 'error', error: { type: 'invalid_request_error', message: 'unparseable body' } }))
        return
      }
      seq++
      const messages = (body.messages ?? []) as Row[]
      const last = messages[messages.length - 1]
      const lastText = rowText(last)
      const turn = /drive turn (\d+)/.exec(lastText)
      const side = !Array.isArray(body.tools) || body.tools.length === 0
      const drops = side ? [] : (fixture.bindingDropsFor(body) as unknown[])
      const refusal = side ? null : fixture.bindingRefusalOf(body, drops)
      const text = refusal !== null ? '' : side ? 'side reply' : turn !== null ? `TURN-${turn[1]}-DONE` : 'ACK'
      const record: CaptureRow = { seq, at: Date.now(), model: String(body.model ?? ''), body, response: { status: refusal === null ? 200 : 400, drops, refusal, text } }
      appendFileSync(captureFile, `${j(record)}\n`)
      if (refusal !== null) {
        res.writeHead(400, { 'content-type': 'application/json', 'request-id': `req_pf_${seq}` })
        res.end(j({ type: 'error', error: { type: 'invalid_request_error', message: refusal } }))
        return
      }
      const scripted = side
        ? { kind: 'text' as const, text, model: MODEL }
        : { kind: 'text' as const, text, thinking: `thinking for ${turn !== null ? `turn ${turn[1]}` : 'this request'}`, model: MODEL, signature: fixture.boundSignature(body), inputTransformations: drops }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_pf_${seq}` })
      res.end(fixture.renderTurn(scripted, seq))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    console.log(`PORT ${typeof address === 'object' && address ? address.port : 0}`)
  })
}

if (process.argv[2] === '--serve') {
  const captureFile = process.argv[3]
  if (!captureFile) {
    console.error('usage: prove-prefix-frozen-drive.ts --serve <captureFile>')
    process.exit(2)
  }
  await serve(captureFile)
} else {
  await drive()
}

type Send = { atTick: number; minTick?: number; afterPrevTicks?: number; awaitText?: string; awaitSettleTicks?: number; data: string; mark?: string }
type Grid = Array<Array<{ c: string }>>
type Payload = { grid: Grid; sendReceipts?: Array<{ atTick?: number }>; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
function gridText(grid: Grid): string {
  return grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}

async function drive(): Promise<void> {
  let failures = 0
  let checks = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    checks++
    if (!ok) failures++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  }
  const section = (t: string): void => {
    console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
  }
  if (!existsSync(DIST)) {
    console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT bundle)')
    process.exit(1)
  }
  const { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
  const driver = resolveCaptureDriver()
  if (driver.kind === 'unavailable') {
    console.log(`FAIL no capture driver: ${driver.reason} — ${driver.remedy}`)
    process.exit(1)
  }
  process.chdir(REPO)
  const { boundTools, withoutCacheControl } = await import('../../src/services/providers/anthropic/prefixLedger.ts')

  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-prefix-frozen-${process.pid}`)
  const CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-prefix-frozen-probe-key'
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  writeFileSync(path.join(RUN_HOME, '.mercury.json'), j({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    hasSeenAutoDefaultNotice: true,
    hasSeenAutoDefaultNudge: true,
    projects: { [CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }))
  writeFileSync(path.join(RUN_HOME, 'settings.json'), j({ permissions: { allow: ['Bash(echo:*)', 'Bash(git:*)', 'Bash(rm:*)', 'Bash(printf:*)', 'Bash(sh:*)'] } }))
  writeFileSync(path.join(CWD, 'README.md'), '# prefix frozen drive fixture\n')
  writeFileSync(path.join(CWD, 'MERCURY.md'), '# project\nbe brief\n')
  const slowServer = path.join(RUN_HOME, 'slow-mcp-server.mjs')
  writeFileSync(slowServer, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
const delay = Number(process.env.MCP_SLOW_TOOLS_MS ?? '6000')
const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'slowsrv', version: '1.0.0' } } }); return }
  if (msg.method === 'tools/list') { setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow_ping', description: 'Late fixture tool.', inputSchema: { type: 'object', properties: {} } }] } }), delay); return }
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method ' + msg.method } })
})
process.stdin.on('end', () => process.exit(0))
`)
  const mcpConfig = j({ mcpServers: { slowsrv: { type: 'stdio', command: 'node', args: [slowServer], env: { MCP_SLOW_TOOLS_MS: '20000' } } } })

  const fixtures: ChildProcess[] = []
  const reap = (): void => {
    for (const fixture of fixtures) {
      try {
        fixture.kill('SIGTERM')
      } catch {
      }
    }
    if (failures === 0) {
      try {
        rmSync(RUN_HOME, { recursive: true, force: true })
      } catch {
      }
    } else {
      console.log(`[forensics] world kept: ${RUN_HOME}`)
    }
  }
  process.on('exit', reap)

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: PROBE_KEY,
    MERCURY_THINKING_BINDING: 'error',
    MERCURY_TOOL_SEARCH: 'on',
    MERCURY_AUTOPILOT: '1',
    MCP_TIMEOUT: '60000',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
  }
  delete baseEnv.NODE_ENV
  delete baseEnv.ANTHROPIC_AUTH_TOKEN
  delete baseEnv.OPENAI_API_KEY
  delete baseEnv.MERCURY_TOOL_DEFER_PROBE
  delete baseEnv.MERCURY_WIRE_DUMP
  delete baseEnv.MERCURY_PREFIX_INDUCE_EDIT

  type Leg = { name: string; payload: Payload | null; status: number | null; stderr: string; captureFile: string; debugFile: string; fired: number[]; seconds: number; finalGrid: string; markGrid(label: string): string }
  async function runLeg(name: string, sends: Send[], total: number, readyText: string, extraEnv: Record<string, string>, extraArgv: string[]): Promise<Leg> {
    const captureFile = path.join(RUN_HOME, `capture-${name}.jsonl`)
    writeFileSync(captureFile, '')
    const fixture = spawn('node', [fileURLToPath(import.meta.url), '--serve', captureFile], { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO })
    fixtures.push(fixture)
    let fixtureStderr = ''
    fixture.stderr?.on('data', (chunk: Buffer) => (fixtureStderr += chunk.toString('utf8')))
    const port = await new Promise<number>((resolve, reject) => {
      const killer = setTimeout(() => reject(new Error(`fixture server never printed PORT (${fixtureStderr.slice(0, 300)})`)), 20_000)
      let buffer = ''
      fixture.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const m = /PORT (\d+)/.exec(buffer)
        if (m) {
          clearTimeout(killer)
          resolve(Number(m[1]))
        }
      })
      fixture.on('exit', code => reject(new Error(`fixture server exited early (${code}) ${fixtureStderr.slice(0, 300)}`)))
    }).catch(err => {
      console.log(`FAIL ${String(err)}`)
      process.exit(1)
    })
    const debugFile = path.join(RUN_HOME, `${name}.debug.log`)
    const out = path.join(RUN_HOME, `grid-${name}.json`)
    const cfg = { argv: ['node', DIST, '--model', MODEL, '--debug-file', debugFile, ...extraArgv], cwd: CWD, sends, readyText: [readyText], stableTicks: 4, total, cols: 120, rows: 40, out }
    const cfgPath = path.join(RUN_HOME, `cfg-${name}.json`)
    writeFileSync(cfgPath, j(cfg))
    const startedAt = Date.now()
    const res = spawnSync(driver.python, [captureEngineEntry(driver, REPO), cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(total * 200 + 40_000),
      cwd: CWD,
      env: { ...baseEnv, ...extraEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
    })
    const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
    return {
      name,
      payload,
      status: res.status,
      stderr: res.stderr ?? '',
      captureFile,
      debugFile,
      fired: sends.map((_, i) => payload?.sendReceipts?.[i]?.atTick ?? -1),
      seconds: Math.round((Date.now() - startedAt) / 1000),
      finalGrid: payload ? gridText(payload.grid) : '',
      markGrid: (label: string): string => {
        const mark = payload?.marks?.find(m => m.label === label)
        return mark ? gridText(mark.grid) : ''
      },
    }
  }

  const readCapture = (file: string): CaptureRow[] => readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as CaptureRow)
  const conversation = (rows: CaptureRow[]): CaptureRow[] => rows.filter(r => Array.isArray(r.body.tools) && r.body.tools.length > 0)
  const sha = (text: string): string => { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return (h >>> 0).toString(16) }
  const digestsOf = (body: WireBody): { system: string; tools: string; messages: string[] } => ({
    system: sha(j(withoutCacheControl(body.system))),
    tools: sha(j(withoutCacheControl(boundTools((body.tools ?? []) as unknown[], (body.messages ?? []) as unknown[])))),
    messages: ((body.messages ?? []) as unknown[]).map(m => sha(j(withoutCacheControl(m)))),
  })
  const pairVerdicts = (rows: CaptureRow[]): Array<{ pair: string; held: boolean; where: string }> => {
    const out: Array<{ pair: string; held: boolean; where: string }> = []
    for (let i = 1; i < rows.length; i++) {
      const a = digestsOf(rows[i - 1]!.body)
      const b = digestsOf(rows[i]!.body)
      let where = ''
      if (a.system !== b.system) where = 'system'
      else if (a.tools !== b.tools) where = 'tools'
      else {
        for (let k = 0; k < a.messages.length; k++) {
          if (a.messages[k] !== b.messages[k]) {
            where = `messages[${k}]`
            break
          }
        }
      }
      out.push({ pair: `#${rows[i - 1]!.seq}→#${rows[i]!.seq}`, held: where === '', where })
    }
    return out
  }
  const sessionFiles = (): string[] => {
    const root = path.join(RUN_HOME, 'projects')
    const out: string[] = []
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        try {
          if (statSync(full).isDirectory()) walk(full)
          else if (full.endsWith('.jsonl')) out.push(full)
        } catch {
        }
      }
    }
    walk(root)
    return out
  }
  const transcriptNotices = (): string[] => sessionFiles().flatMap(file => readFileSync(file, 'utf8').split('\n').filter(l => l.includes('Preserved thinking')).map(l => { try { const row = JSON.parse(l) as { payload?: { kind?: string; content?: string } }; return row.payload?.kind === 'notice' ? String(row.payload.content ?? '') : '' } catch { return '' } }).filter(s => s !== ''))
  const debugText = (file: string): string => { try { return readFileSync(file, 'utf8') } catch { return '' } }

  console.log('============================================================')
  console.log(' prefix frozen DRIVE — the built bundle in a PTY, the binding set to error')
  console.log('============================================================')

  const CYCLE: Send[] = Array.from({ length: 7 }, (_, i) => ({ atTick: 700 + i * 4, afterPrevTicks: 4, data: '\x1b[Z', mark: `mode-${i + 1}` }))
  const sends1: Send[] = [
    { atTick: 120, minTick: 3, awaitText: 'Yes, I accept', awaitSettleTicks: 2, data: '\x1b[B\r', mark: 'consent' },
    { atTick: 300, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
    { atTick: 540, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: 'drive turn 1\r', mark: 'chat' },
    { atTick: 680, minTick: 10, awaitText: 'TURN-1-DONE', awaitSettleTicks: 4, data: '', mark: 't1' },
    ...CYCLE,
    { atTick: 760, afterPrevTicks: 6, data: 'drive turn 2\r', mark: 'cycled' },
    { atTick: 900, minTick: 10, awaitText: 'TURN-2-DONE', awaitSettleTicks: 4, data: '! git init -q\r', mark: 't2' },
    { atTick: 960, afterPrevTicks: 12, data: 'drive turn 3\r', mark: 'git-init' },
    { atTick: 1100, minTick: 10, awaitText: 'TURN-3-DONE', awaitSettleTicks: 4, data: '! rm -rf .git\r', mark: 't3' },
    { atTick: 1160, afterPrevTicks: 12, data: 'drive turn 4\r', mark: 'git-gone' },
    { atTick: 1300, minTick: 10, awaitText: 'TURN-4-DONE', awaitSettleTicks: 4, data: "! printf '# project\\nbe briefer\\n' > MERCURY.md\r", mark: 't4' },
    { atTick: 1360, afterPrevTicks: 12, data: 'drive turn 5\r', mark: 'instructions-edited' },
    { atTick: 1500, minTick: 10, awaitText: 'TURN-5-DONE', awaitSettleTicks: 4, data: `! sh -c 'printf %s "{\\"permissions\\":{\\"allow\\":[\\"Bash(echo:*)\\",\\"Bash(git:*)\\",\\"Bash(rm:*)\\",\\"Bash(printf:*)\\",\\"Bash(sh:*)\\",\\"Read\\"]},\\"language\\":\\"\\"}" > "$MERCURY_CONFIG_DIR/settings.json"'\r`, mark: 't5' },
    { atTick: 1560, afterPrevTicks: 12, data: 'drive turn 6\r', mark: 'settings-edited' },
    { atTick: 1700, minTick: 10, awaitText: 'TURN-6-DONE', awaitSettleTicks: 4, data: '/effort low\r', mark: 't6' },
    { atTick: 1740, afterPrevTicks: 8, data: 'drive turn 7\r', mark: 'effort' },
    { atTick: 1880, minTick: 10, awaitText: 'TURN-7-DONE', awaitSettleTicks: 4, data: 'drive turn 8\r', mark: 't7' },
    { atTick: 2020, minTick: 10, awaitText: 'TURN-8-DONE', awaitSettleTicks: 4, data: 'drive turn 9\r', mark: 't8' },
    { atTick: 2160, minTick: 10, awaitText: 'TURN-9-DONE', awaitSettleTicks: 4, data: 'drive turn 10\r', mark: 't9' },
  ]
  section('1D — leg 1 (ten turns, every perturbation): the drive completed')
  const leg1 = await runLeg('frozen', sends1, 2320, 'TURN-10-DONE', {}, ['--allow-dangerously-skip-permissions', '--mcp-config', mcpConfig, '--strict-mcp-config'])
  check('leg 1: vshot exited 0 with a grid', leg1.status === 0 && leg1.payload !== null, `status=${leg1.status} stderr=${leg1.stderr.slice(-400)}`)
  console.log(`  leg 1: sends fired at ticks ${leg1.fired.join(', ')}; ended: ${leg1.payload?.endReason ?? '?'} after ${leg1.seconds}s`)
  check('leg 1: the tenth reply painted (TURN-10-DONE)', leg1.finalGrid.includes('TURN-10-DONE'), leg1.finalGrid.split('\n').slice(-14).join('\n'))
  const modesSeen = Array.from({ length: 7 }, (_, i) => leg1.markGrid(`mode-${i + 1}`)).map(g => (/([a-z]+ (?:mode )?on)/i.exec(g)?.[1] ?? 'no band'))
  console.log(`  leg 1: the band after each shift+tab: ${modesSeen.join(' · ')}`)
  check('leg 1: the mode cycle happened (at least three stations painted a band)', new Set(modesSeen.filter(m => m !== 'no band')).size >= 3, modesSeen.join(' · '))

  section('1W — leg 1: the wire')
  const rows1 = conversation(readCapture(leg1.captureFile))
  const verdicts1 = pairVerdicts(rows1)
  for (const v of verdicts1) console.log(`    ${v.pair} ${v.held ? 'HELD' : `BROKE at ${v.where}`}`)
  check('leg 1: at least ten conversation requests', rows1.length >= 10, String(rows1.length))
  check('leg 1: the fixture refused nothing (a rewrite under `error` would have)', rows1.every(r => r.response.refusal === null), rows1.filter(r => r.response.refusal !== null).map(r => `#${r.seq} ${r.response.refusal}`).join(' | '))
  check('leg 1: every drop list is empty', rows1.every(r => r.response.drops.length === 0), rows1.filter(r => r.response.drops.length > 0).map(r => `#${r.seq} ${j(r.response.drops[0])}`).join(' | '))
  check('leg 1: every consecutive pair holds (system, bound tools, the shared messages)', verdicts1.every(v => v.held), verdicts1.filter(v => !v.held).map(v => `${v.pair} ${v.where}`).join(' | '))
  const systemDigests = new Set(rows1.map(r => digestsOf(r.body).system))
  const toolDigests = new Set(rows1.map(r => digestsOf(r.body).tools))
  check('leg 1: one system digest and one bound-tools digest across the whole session (the ledger\'s constant)', systemDigests.size === 1 && toolDigests.size === 1, `system=${systemDigests.size} tools=${toolDigests.size}`)
  const lastBody = rows1[rows1.length - 1]!.body
  const history = j(lastBody.messages ?? [])
  check('leg 1: the git init and its removal rode the history as appended rows (never the system prompt)', history.includes('git init') && !j(withoutCacheControl(lastBody.system)).includes('git repository'), history.includes('git init') ? 'system carries the fact' : 'no git init row')
  const landed = rows1.some(r => Array.isArray(r.body.tools) && (r.body.tools as Array<{ name?: string }>).some(t => t.name === 'mcp__slowsrv__slow_ping'))
  const firstTools = (rows1[0]!.body.tools as Array<{ name?: string }>).map(t => t.name)
  console.log(`  leg 1: the late MCP tool ${landed ? 'joined the tools array mid-session (deferred, unreferenced — outside the bound prefix)' : 'never reached a request'}; first request carried ${firstTools.length} tools`)
  check('leg 1: the slow MCP server\'s tool rode the tools array deferred (outside the bound prefix) and every pair held', landed && verdicts1.every(v => v.held), landed ? 'a pair broke' : 'never landed')
  const notices1 = transcriptNotices()
  check('leg 1: no receipt painted, no ledger line, no doctor row', notices1.length === 0 && !debugText(leg1.debugFile).includes('prefix ledger names') && !existsSync(path.join(RUN_HOME, 'preserved-thinking.json')), notices1.join(' | ').slice(0, 300))

  section('2D — leg 2 (the induced edit): the fixture refuses the edited request; the ledger names the part')
  const sends2: Send[] = [
    { atTick: 200, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
    { atTick: 540, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 3, data: 'drive turn 1\r', mark: 'chat' },
    { atTick: 680, minTick: 10, awaitText: 'TURN-1-DONE', awaitSettleTicks: 4, data: 'drive turn 2\r', mark: 't1' },
    { atTick: 800, afterPrevTicks: 40, data: '', mark: 'after' },
  ]
  for (const f of sessionFiles()) rmSync(f, { force: true })
  const leg2 = await runLeg('induced', sends2, 600, 'NEVER-PAINTS', { MERCURY_PREFIX_INDUCE_EDIT: 'system' }, [])
  check('leg 2: the capture ended with a grid (a budget end after the refusal)', leg2.payload !== null && (leg2.status === 0 || leg2.status === 3), `status=${leg2.status} stderr=${leg2.stderr.slice(-300)}`)
  const rows2 = conversation(readCapture(leg2.captureFile))
  const refused2 = rows2.filter(r => r.response.refusal !== null)
  check('leg 2: the second request carried the induced edit and the fixture refused it (a rewrite fails the run under `error`)', refused2.length >= 1 && j(withoutCacheControl(refused2[0]!.body.system)).includes('[induced edit]') && (refused2[0]!.response.refusal ?? '').includes('binding does not match'), refused2.map(r => `#${r.seq} ${r.response.refusal}`).join(' | ').slice(0, 300))
  const ledgerLines = debugText(leg2.debugFile).split('\n').filter(l => l.includes('prefix ledger names a rewrite'))
  check("leg 2: the ledger named the part before the request went out — the system prompt's section", ledgerLines.length >= 1 && ledgerLines[0]!.includes("the system prompt's"), ledgerLines.join(' | ').slice(0, 300))
  check('leg 2: the operator saw the refusal on screen (an API error, never a silent stall)', /400|invalid_request|binding does not match|error/i.test(leg2.finalGrid), leg2.finalGrid.split('\n').slice(-12).join('\n'))

  if (failures > 0) {
    console.log(`[forensics] leg 1 capture: ${leg1.captureFile}; debug: ${leg1.debugFile}`)
    console.log(`[forensics] leg 2 capture: ${leg2.captureFile}; debug: ${leg2.debugFile}`)
    console.log(`[forensics] leg 1 final screen:\n${leg1.finalGrid.split('\n').slice(-24).join('\n')}`)
  }
  console.log(`\n ${checks} checks, ${failures} failures`)
  process.exit(failures === 0 ? 0 : 1)
}

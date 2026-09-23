#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '../..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = arg('--dist') ?? join(ROOT, 'dist/mercury.mjs')
const FRAMES = arg('--frames')
const driver = resolveCaptureDriver()
const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
if (driver.kind !== 'posix-pty') {
  console.log(`${hosted ? 'FAIL' : '__SUITE_SKIPPED'} live-read-search-collapse: requires the POSIX tee reader, got ${driver.kind}`)
  process.exit(hosted ? 1 : 0)
}
const preflight = preflightCaptureDriver(driver, ROOT)
if (!preflight.ok) {
  console.log(`${hosted ? 'FAIL' : '__SUITE_SKIPPED'} ${describeCapturePreflight(preflight)}`)
  process.exit(hosted ? 1 : 0)
}
if (!existsSync(DIST)) throw new Error(`Build first: ${DIST}`)
const node = join(dirname(DIST), 'vendor/node/bin/node')
const NODE = existsSync(node) ? node : 'node'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'live-count-')))
const SIZES = (arg('--sizes') ?? '120x40').split(',').map(s => s.split('x').map(Number))
const wanted = (arg('--scenes') ?? 'read,search,shell,lone,disclosure').split(',')
const ASK = 'Inspect the fixture inputs.'
const DONE = 'The fixture inspection is complete.'
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = { cols: number; rows: number; grid: Cell[][] }
type Mark = Grid & { label: string; atTick: number }
type Payload = Grid & { readyAt: number | null; endReason: string; marks?: Mark[] }
type Frame = { i: number; tick: number; lines: string[] }
type Result = { type?: string; tool_use_id?: string; is_error?: boolean }
type Message = { content?: string | Result[] }
type Wire = { count: number; results: Array<{ id: string; error: boolean }> }
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail.slice(0, 800)}`}`)
}
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const finish = (reason: string): string => sse('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } }) + sse('message_stop', { type: 'message_stop' })
const linesOf = (p: Grid): string[] => p.grid.map(row => row.map(c => c.c).join(''))
function pane(lines: string[]): string[] {
  const title = lines.findIndex(l => l.includes('✶ VIEW'))
  if (title < 1) return []
  const left = lines[title]!.indexOf('✶ VIEW') - 2
  const right = lines[title - 1]!.indexOf('╮', left)
  const bottom = lines.findLastIndex(l => l[left] === '╰' && l[right] === '╯')
  if (right <= left || bottom <= title) return []
  const inner = lines.slice(title + 1, bottom).map(l => l.slice(left + 1, right))
  const hero = inner.findIndex(l => /^\s*╰─+╯\s*$/.test(l))
  return inner.slice(hero + 1)
}
function cardCells(p: Grid, text: string): Cell[] {
  const row = p.grid.find(r => r.map(c => c.c).join('').includes(text))
  if (!row) return []
  const line = row.map(c => c.c).join('')
  const at = line.indexOf(text)
  const plate = line.lastIndexOf('[Mercury]', at)
  const end = line.indexOf('⌄', at)
  return plate < 0 || end < 0 ? [] : row.slice(plate + '[Mercury]'.length, end + 1)
}
async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const proc = spawn(driver.python, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  proc.stdout.on('data', b => { output += String(b) })
  proc.stderr.on('data', b => { output += String(b) })
  const timer = setTimeout(() => proc.kill('SIGKILL'), vshotBudgetMs(120_000))
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  return { code, output }
}
function transcriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? transcriptFiles(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : [])
}

try {
  for (const scene of wanted) for (const [cols, rows] of SIZES) {
    if (!['read', 'search', 'shell', 'lone', 'disclosure'].includes(scene)) throw new Error(`Unknown scene ${scene}`)
    const count = scene === 'lone' ? 1 : scene === 'disclosure' ? 4 : 16
    const tag = `${scene}-${cols}x${rows}`
    const world = join(SCRATCH, tag)
    const cwd = join(world, 'inputs')
    const home = join(world, 'home')
    const dest = FRAMES ? join(FRAMES, tag) : world
    mkdirSync(cwd, { recursive: true })
    mkdirSync(dest, { recursive: true })
    for (let n = 1; n <= count; n++) writeFileSync(join(cwd, `f${String(n).padStart(2, '0')}.txt`), `Fixture ${n}.\n`)
    seedFirstRun(home, [cwd])
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ spinnerTipsEnabled: false, ...(scene === 'shell' ? { permissions: { allow: ['Bash(printf:*)'] } } : {}) }))
    const wire: Wire[] = []
    let burst = false
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', b => chunks.push(b))
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.split('?')[0]?.endsWith('/v1/messages')) { res.writeHead(404).end(); return }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string; messages?: Message[]; tools?: unknown[] }
        const target = JSON.stringify(body.messages).includes(ASK) && (body.tools?.length ?? 0) > 0
        const results = (body.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result').map(b => ({ id: b.tool_use_id ?? '', error: b.is_error === true })) : [])
        wire.push({ count: target && !burst ? count : 0, results })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse('message_start', { type: 'message_start', message: { id: `msg_count_${wire.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } }))
        if (!target || burst) {
          res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
          res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: target ? DONE : 'ok' } }))
          res.end(sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + finish('end_turn'))
          return
        }
        burst = true
        let i = 0
        const next = (): void => {
          if (res.destroyed || res.writableEnded) return
          if (i === count) { res.end(finish('tool_use')); return }
          const index = i++
          const file = join(cwd, `f${String(i).padStart(2, '0')}.txt`)
          const name = scene === 'search' ? 'Grep' : scene === 'shell' ? 'Bash' : 'Read'
          const input = scene === 'search' ? { pattern: `Fixture ${i}`, path: file } : scene === 'shell' ? { command: `printf 'fixture-${String(i).padStart(2, '0')}\\n'`, description: `Print fixture ${i}` } : { file_path: file }
          res.write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_count_${index}`, name, input: {} } }))
          res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
          res.write(sse('content_block_stop', { type: 'content_block_stop', index }))
          setTimeout(next, vshotBudgetMs(i === count ? 2200 : scene === 'disclosure' && i === 1 ? 2500 : 650)).unref()
        }
        setTimeout(next, 400).unref()
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: '.daemon',
      MERCURY_TEAMS_DIR: join(home, 'teams'), MERCURY_TABULA_DIR: join(home, 'tabula'),
      MERCURY_HOME: join(home, 'files'), MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'),
      MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      MERCURY_IDE_SKIP_AUTO_INSTALL: '1', MERCURY_DESKTOP_DRIVER: 'none',
      MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_TURN_RECEIPT: '0',
      MERCURY_UPDATE_NOTICE: '0', MERCURY_TERMINAL_TITLE: '0', MERCURY_DECK_COMPANION: '0',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      VSHOT_TEE: join(dest, 'capture.tee'), BROWSER: '/usr/bin/true',
    }
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_ENV', 'CI', 'MERCURY_ANTHROPIC_CLIENT_CONTRACT']) delete env[key]
    const summary = scene === 'search' ? `Searched for ${count} patterns` : scene === 'shell' ? `Ran ${count} bash commands` : `Read ${count} ${count === 1 ? 'file' : 'files'}`
    const cfg = join(dest, 'cfg.json')
    const grid = join(dest, 'grid.json')
    const sends: Record<string, unknown>[] = [
      { awaitText: '↑↓ choose', requireAwait: true, awaitSettleTicks: 3, data: '\r' },
      { awaitText: 'ready ·', targetText: '← back', requireAwait: true, awaitSettleTicks: 5, data: ASK },
      { afterPrevTicks: 2, data: '\r' },
    ]
    if (scene === 'disclosure') sends.push(
      { awaitText: 'Reading 1 file', targetText: 'Reading 1 file', targetDx: 3, requireAwait: true, awaitSettleTicks: 2, data: CLICK, mark: 'live' },
      { awaitText: 'Expanded group (1 call)', requireAwait: true, awaitSettleTicks: 2, data: '', mark: 'live-expanded' },
      { awaitText: 'Expanded group', targetText: 'Expanded group', targetDx: 3, requireAwait: true, data: CLICK },
      { awaitText: 'ready ·', targetText: summary, targetDx: 3, requireAwait: true, awaitSettleTicks: 3, data: CLICK, mark: 'settled' },
      { awaitText: 'Expanded group (4 calls)', requireAwait: true, awaitSettleTicks: 2, data: '', mark: 'settled-expanded' },
      { awaitText: 'Expanded group', targetText: 'Expanded group', targetDx: 3, requireAwait: true, data: CLICK },
    )
    writeFileSync(cfg, JSON.stringify({ argv: [NODE, DIST], cwd, cols, rows, total: 350, out: grid, sends, readyText: [DONE, summary, 'ready ·'], readySettleTicks: 5 }))
    try {
      rmSync(env.VSHOT_TEE!, { force: true })
      const cap = await run([captureEngineEntry(driver, ROOT), cfg], cwd, env)
      writeFileSync(join(dest, 'capture.log'), cap.output)
      writeFileSync(join(dest, 'wire.json'), JSON.stringify(wire, null, 2))
      check(`${tag}: the complete journey reached ready`, cap.code === 0, cap.output)
      if (cap.code !== 0 || !existsSync(grid)) continue
      const payload = JSON.parse(readFileSync(grid, 'utf8')) as Payload
      check(`${tag}: all calls executed and returned successfully`, wire.some(w => w.results.length === count && new Set(w.results.map(r => r.id)).size === count && w.results.every(r => !r.error)))
      const replay = await run([join(ROOT, 'scripts/ui/tee-rows.py'), env.VSHOT_TEE!, String(cols), String(rows)], cwd, env)
      if (replay.code !== 0) throw new Error(replay.output)
      writeFileSync(join(dest, 'frames.jsonl'), replay.output)
      const frames = replay.output.trim().split('\n').map(l => JSON.parse(l) as Frame)
      const samples = frames.map(f => {
        const rows = pane(f.lines)
        const summaries = rows.flatMap(l => [...l.matchAll(/\b(?:Read(?:ing)?|Search(?:ing|ed) for|Ran|Running) (\d+) (?:files?|patterns?|bash commands?)\b/g)].map(m => Number(m[1])))
        const individual = rows.filter(l => /[▤▰⌕]\s+(?:Read|Bash|Grep)\s|\b(?:Read|Bash|Grep)\s+f\d\d\.txt/.test(l)).length
        return { frame: f.i, tick: f.tick, count: summaries[0] ?? 0, rows: summaries.length + individual, expanded: rows.some(l => l.includes('Expanded group')) }
      })
      writeFileSync(join(dest, 'ticks.json'), JSON.stringify(samples, null, 2))
      if (scene !== 'disclosure') {
        const start = samples.findIndex(s => s.rows > 0)
        const live = samples.slice(Math.max(0, start))
        const bad = live.filter(s => s.rows !== 1 || s.count < 1)
        check(`${tag}: every emitted frame keeps exactly one numbered row`, start >= 0 && bad.length === 0, JSON.stringify(bad.slice(0, 5)))
        const dipped = live.filter((s, i) => i > 0 && s.count < live[i - 1]!.count)
        check(`${tag}: the count never decreases`, dipped.length === 0, JSON.stringify(dipped.slice(0, 5)))
        check(`${tag}: every count from one through ${count} was observed`, Array.from({ length: count }, (_, i) => i + 1).every(n => live.some(s => s.count === n)))
        const ticks = new Map<number, typeof samples[number]>()
        for (const s of live) ticks.set(s.tick, s)
        const perTick: typeof samples = []
        let carried = live[0]
        for (let tick = carried?.tick ?? 0; carried && tick <= live.at(-1)!.tick; tick++) {
          carried = ticks.get(tick) ?? carried
          perTick.push({ ...carried, tick })
        }
        writeFileSync(join(dest, 'per-tick.json'), JSON.stringify(perTick, null, 2))
      } else {
        const marks = new Map((payload.marks ?? []).map(m => [m.label, pane(linesOf(m)).join('\n')]))
        check(`${tag}: clicking the first live card reveals its file`, (marks.get('live-expanded') ?? '').includes('Expanded group (1 call)') && (marks.get('live-expanded') ?? '').includes('f01.txt'))
        check(`${tag}: clicking the settled card reveals every file`, (marks.get('settled-expanded') ?? '').includes('Expanded group (4 calls)') && [1, 2, 3, 4].every(n => (marks.get('settled-expanded') ?? '').includes(`f0${n}.txt`)))
      }
      const transcript = transcriptFiles(join(home, 'projects')).find(f => !f.includes('subagents') && readFileSync(f, 'utf8').includes(ASK))
      check(`${tag}: the real session transcript was recorded`, transcript !== undefined)
      if (transcript === undefined) continue
      const referenceCfg = join(dest, 'reference-cfg.json')
      const referenceGrid = join(dest, 'reference-grid.json')
      writeFileSync(referenceCfg, JSON.stringify({ argv: [NODE, DIST, '--resume', basename(transcript, '.jsonl')], cwd, cols, rows, total: 200, out: referenceGrid, readyText: [summary, 'ready ·'], readySettleTicks: 5 }))
      const reference = await run([captureEngineEntry(driver, ROOT), referenceCfg], cwd, { ...env, VSHOT_TEE: join(dest, 'reference.tee') })
      writeFileSync(join(dest, 'reference.log'), reference.output)
      check(`${tag}: the recorded-only reference reached ready`, reference.code === 0, reference.output)
      if (reference.code === 0) {
        const cells = cardCells(payload, summary)
        const stored = cardCells(JSON.parse(readFileSync(referenceGrid, 'utf8')) as Grid, summary)
        check(`${tag}: the final cells equal the same build's recorded-only card`, cells.length > 0 && JSON.stringify(cells) === JSON.stringify(stored), `live=${cells.length} recorded=${stored.length}`)
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

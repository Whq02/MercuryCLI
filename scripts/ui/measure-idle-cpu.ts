#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = resolve(process.env.MEASURE_DIST ?? join(REPO, 'dist', 'mercury.mjs'))
const NODE = join(dirname(BIN), 'vendor', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`measure-idle-cpu: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

const WINDOW_SKIP_MS = 2_000
const WINDOW_MS = Number(process.env.MEASURE_WINDOW_S ?? '30') * 1000
const INTERPRETED_FLAGS = ['--no-opt', '--no-maglev', '--no-sparkplug']
type Variant = { nodeFlags: string[]; cols: number; rows: number; env?: Record<string, string> }
const VARIANTS: Record<string, Variant> = {
  optimised: { nodeFlags: [], cols: 120, rows: 40 },
  interpreted: { nodeFlags: INTERPRETED_FLAGS, cols: 120, rows: 40 },
  'interpreted-wide': { nodeFlags: INTERPRETED_FLAGS, cols: 300, rows: 90 },
  padded: { nodeFlags: [], cols: 120, rows: 40, env: { MERCURY_FRAME_COST_PAD_MS: '100' } },
}
type Setting = 'full' | 'auto' | 'reduced' | 'off'
const SETTINGS = (process.env.MEASURE_SETTINGS ?? 'full,auto').split(',') as Setting[]
if (SETTINGS.some(value => !['auto', 'full', 'reduced', 'off'].includes(value))) throw new Error('Unknown Motion setting')
if (!Number.isFinite(WINDOW_MS) || WINDOW_MS <= 0) throw new Error('MEASURE_WINDOW_S must be a positive number')
const blurred = process.argv.includes('--blur')
const variants = process.argv.slice(2).filter(value => value !== '--blur')
const wanted = variants.length > 0 ? variants : Object.keys(VARIANTS)
if (wanted.some(value => VARIANTS[value] === undefined)) throw new Error('Unknown measurement variant')

function acceptedNodeFlags(flags: string[]): string[] {
  return flags.filter(flag => spawnSync(NODE, [flag, '--version'], { stdio: 'ignore' }).status === 0)
}

async function startFixture(port: number): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function seedWorld(setting: Setting): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'idle-cpu-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'idle-cpu-cwd-')))
  writeFileSync(join(cwd, 'notes.txt'), 'idle notes\n')
  seedFirstRun(home, [cwd])
  if (setting !== 'auto') {
    const cfgPath = join(home, '.mercury.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg.motion = setting
    writeFileSync(cfgPath, JSON.stringify(cfg))
  }
  return { home, cwd }
}

function baseEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    HOME: home,
    PATH: `${dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: 'xterm-256color',
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
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
}

function cpuSampleOf(pid: number): { cpu: number; pcpu: number } | null {
  const out = spawnSync('ps', ['-p', String(pid), '-o', '%cpu=', '-o', 'time='], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const fields = out.stdout.trim().split(/\s+/)
  if (fields.length !== 2) return null
  const pcpu = Number(fields[0])
  const parts = fields[1]!.split(':').map(Number)
  if (!Number.isFinite(pcpu) || parts.some(n => !Number.isFinite(n))) return null
  return { cpu: parts.reduce((acc, n) => acc * 60 + n, 0), pcpu }
}

type Receipt = { atTick: number; ts: number }
type Sample = { ts: number; cpu: number; pcpu: number }
async function capture(
  cfg: Record<string, unknown>,
  env: Record<string, string>,
  budgetMs: number,
  pidPath: string,
): Promise<{ receipts: Receipt[]; endReason: string; text: string; samples: Sample[]; pid: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'idle-cpu-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const samples: Sample[] = []
  let pid: number | null = null
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(budgetMs))
    const meter = setInterval(() => {
      if (pid === null && existsSync(pidPath)) {
        const n = Number(readFileSync(pidPath, 'utf8').trim())
        if (Number.isFinite(n) && n > 0) pid = n
      }
      if (pid === null) return
      const sample = cpuSampleOf(pid)
      if (sample !== null) samples.push({ ts: Date.now(), ...sample })
    }, 1000)
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', error => { clearTimeout(deadline); clearInterval(meter); reject(error) })
    child.on('close', code => {
      clearTimeout(deadline)
      clearInterval(meter)
      if (code === 0) resolve()
      else reject(new Error(`Capture exited ${code}: ${stderr.join('').slice(-700)}`))
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Array<Array<{ c?: string }>>; sendReceipts?: Receipt[]; endReason?: string }
  rmSync(dir, { recursive: true, force: true })
  return {
    receipts: payload.sendReceipts ?? [],
    endReason: payload.endReason ?? '',
    text: payload.grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n'),
    samples,
    pid,
  }
}

function sampleNear(samples: Sample[], ts: number): Sample | null {
  let best: Sample | null = null
  for (const s of samples) if (best === null || Math.abs(s.ts - ts) < Math.abs(best.ts - ts)) best = s
  return best !== null && Math.abs(best.ts - ts) <= 1500 ? best : null
}

const outDir = process.env.MEASURE_OUT_DIR ?? mkdtempSync(join(tmpdir(), 'idle-cpu-tee-'))
mkdirSync(outDir, { recursive: true })
console.log('============================================================')
console.log(` idle cpu — ${BIN}, ${WINDOW_MS / 1000} idle seconds per boot, ${blurred ? 'unfocused' : 'focused'}; Motion ${SETTINGS.join(', ')}`)
console.log('============================================================')
const fixture = await startFixture(Number(process.env.MEASURE_PORT ?? 0))
let measurementFailures = 0
const results: Array<{ variant: string; setting: Setting; flags: string[]; cols: number; rows: number; cpuSeconds: number | null; corePct: number | null; writes: number; bytes: number; word: boolean; endReason: string; blurred: boolean; sampleCount: number; psMeanPct: number | null; psP95Pct: number | null }> = []
const boots: Array<{ variant: string; spec: Variant; setting: Setting }> = []
for (const variant of wanted) {
  const spec = VARIANTS[variant]
  if (spec === undefined) {
    console.log(`  ? unknown variant ${variant} (known: ${Object.keys(VARIANTS).join(', ')})`)
    continue
  }
  for (const setting of SETTINGS) boots.push({ variant, spec, setting })
}
for (const { variant, spec, setting } of boots) {
  const flags = acceptedNodeFlags(spec.nodeFlags)
  const COLS = spec.cols
  const ROWS = spec.rows
  const { home, cwd } = seedWorld(setting)
  const tee = join(outDir, `tee-${variant}-${setting}.jsonl`)
  const pidPath = join(outDir, `pid-${variant}-${setting}.txt`)
  rmSync(tee, { force: true })
  rmSync(`${tee}.raw`, { force: true })
  rmSync(pidPath, { force: true })
  const settleTicks = 50
  const total = 12 * 5 + settleTicks + Math.ceil((WINDOW_SKIP_MS + WINDOW_MS) / 200) + 25
  let cap: Awaited<ReturnType<typeof capture>> | null = null
  try {
    cap = await capture(
      {
        argv: ['/bin/sh', '-c', 'echo $$ > "$0" && exec "$@"', pidPath, NODE, ...flags, BIN],
        cwd,
        cols: COLS,
        rows: ROWS,
        sends: [
          { data: '\r', awaitText: 'New Session', requireAwait: true, atTick: 100, awaitSettleTicks: 6 },
          { data: '', awaitText: 'type a prompt, or / for commands', requireAwait: true, atTick: 150 },
          { data: blurred ? '\u001b[O' : '', afterPrevTicks: settleTicks, mark: 'settled' },
        ],
        total,
      },
      { ...baseEnv(home, fixture.base), ...(spec.env ?? {}), INK_WRITE_TEE: tee },
      total * 200 + 30_000,
      pidPath,
    )
  } catch (error) {
    measurementFailures++
    console.error(`${variant} / ${setting}: capture failed: ${String(error).slice(0, 300)}`)
  } finally {
    spawnSync(NODE, [BIN, 'daemon', 'stop'], { env: baseEnv(home, fixture.base), timeout: 10000, stdio: 'pipe' })
  }
  if (cap !== null) {
    const start = (cap.receipts[2]?.ts ?? 0) + WINDOW_SKIP_MS
    const end = start + WINDOW_MS
    const windowSamples = cap.samples.filter(sample => sample.ts >= start && sample.ts < end)
    const pcpu = windowSamples.map(sample => sample.pcpu).sort((a, b) => a - b)
    const psMeanPct = pcpu.length > 0 ? pcpu.reduce((sum, value) => sum + value, 0) / pcpu.length : null
    const psP95Pct = pcpu[Math.round(0.95 * (pcpu.length - 1))] ?? null
    const a = sampleNear(cap.samples, start)
    const b = sampleNear(cap.samples, end)
    const cpuSeconds = a !== null && b !== null ? Math.max(0, b.cpu - a.cpu) : null
    const span = a !== null && b !== null ? (b.ts - a.ts) / 1000 : null
    const corePct = cpuSeconds !== null && span !== null && span > 0 ? (100 * cpuSeconds) / span : null
    let writes = 0
    let bytes = 0
    if (existsSync(tee)) {
      for (const line of readFileSync(tee, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        let row: { ts?: number; len?: number }
        try {
          row = JSON.parse(line) as { ts?: number; len?: number }
        } catch {
          continue
        }
        if (typeof row.ts !== 'number' || row.ts < start || row.ts >= end) continue
        writes += 1
        bytes += row.len ?? 0
      }
    }
    const chatOpen = /SESSION|this session/i.test(cap.text)
    if (!chatOpen || a === null || b === null || pcpu.length === 0) measurementFailures++
    const word = /\breduced\b/.test(cap.text)
    results.push({ variant, setting, flags, cols: COLS, rows: ROWS, cpuSeconds, corePct, writes, bytes, word, endReason: cap.endReason, blurred, sampleCount: pcpu.length, psMeanPct, psP95Pct })
    writeFileSync(join(outDir, `samples-${variant}-${setting}.json`), JSON.stringify({ binary: BIN, node: NODE, start, end, blurred, samples: cap.samples }))
    console.log(`  ps CPU: mean ${psMeanPct?.toFixed(2) ?? '?'}% / p95 ${psP95Pct?.toFixed(2) ?? '?'}% / ${pcpu.length} samples`)
    console.log(`\n── ${variant} · Motion ${setting} ──`)
    console.log(`  ${COLS}×${ROWS} · node flags: ${flags.length > 0 ? flags.join(' ') : '(none)'}${spec.env ? ` · env ${Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''} · screen pid: ${cap.pid ?? '?'} · samples: ${cap.samples.length}`)
    console.log(`  window: ${new Date(start).toISOString()} → +${WINDOW_MS / 1000}s · capture ended: ${cap.endReason} · cockpit header on screen: ${chatOpen ? 'yes' : 'NO'}`)
    console.log(`  cpu seconds in the window: ${cpuSeconds === null ? '?' : cpuSeconds.toFixed(2)} · share of one core: ${corePct === null ? '?' : `${corePct.toFixed(1)}%`}${span !== null ? ` (over ${span.toFixed(0)} s)` : ''}`)
    console.log(`  terminal writes in the window: ${writes} · bytes: ${bytes} · the status spine says reduced at the end: ${word ? 'yes' : 'no'}`)
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
await fixture.close()
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results, null, 2))
process.exitCode = measurementFailures > 0 ? 1 : 0
console.log(`\n── summary (per ${WINDOW_MS / 1000} idle seconds) ──`)
for (const r of results) {
  console.log(`  ${r.variant.padEnd(17)} ${r.setting.padEnd(5)} ${`${r.cols}×${r.rows}`.padEnd(7)} cpu=${r.cpuSeconds === null ? '?' : `${r.cpuSeconds.toFixed(2)}s`} core=${r.corePct === null ? '?' : `${r.corePct.toFixed(1)}%`} writes=${r.writes} bytes=${r.bytes} reduced-word=${r.word ? 'yes' : 'no'} flags=${r.flags.join(' ') || '(none)'}`)
}
if (process.env.MEASURE_OUT_DIR === undefined) rmSync(outDir, { recursive: true, force: true })
else console.log(`  tee files kept under ${outDir}`)

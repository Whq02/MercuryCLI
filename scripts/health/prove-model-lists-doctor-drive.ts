#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first or name a bundle with --dist`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'model-lists-doctor-')))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_RENDER_CWD = CWD
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_HOME

const { guardLoginDriverWrite } = await import('../lib/loginDriverGuard.ts')
guardLoginDriverWrite('the model lists doctor drive', process.env)
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const scenarios = await import('../ui/renderScenarios.ts')
const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.ts')
seedFirstRun(HOME, [CWD])

const TYPED = GPT_DISPLAY_PINS.map(pin => pin.id)
if (TYPED.length < 3) {
  console.error(`✗ the GPT typed table holds ${TYPED.length} ids — the drive needs three to serve some and withhold two`)
  process.exit(1)
}
const OWNER_LIST = TYPED.slice(0, -2)
const RETIRED = TYPED.slice(-2)
const hits: string[] = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  hits.push(`${req.method} ${path}`)
  if (req.method === 'GET' && path === '/openai/chatgpt/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: OWNER_LIST.map((slug, i) => ({ slug, display_name: slug, supported_reasoning_levels: ['low', 'high'], visibility: 'list', priority: i + 1 })) }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
writeFileSync(
  join(HOME, '.openai-auth.json'),
  JSON.stringify({ version: 1, tokens: { idToken: 'fixture-id-token', accessToken: 'fixture-chatgpt-access-token-0001', refreshToken: 'fixture-refresh-token-0001', accountId: 'acct_fixture', planType: 'pro', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 24 * 3600_000 } }),
)

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
  MERCURY_HOME: '',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_WARM_RUNNER: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:1',
  MERCURY_GEMINI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_DEEPSEEK_API_BASE: 'http://127.0.0.1:1',
  MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_MOONSHOT_API_BASE: 'http://127.0.0.1:1',
  MERCURY_HUGGINGFACE_API_BASE: 'http://127.0.0.1:1',
  BROWSER: '/usr/bin/true',
}
for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete childEnv[name]

type Row = { id?: string; label?: string; evidence?: string; detail?: string; status?: string; fix?: string }
function rowsOf(jsonText: string): Row[] {
  const rows: Row[] = []
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v)
      return
    }
    if (o && typeof o === 'object') {
      const r = o as Row
      if (typeof r.id === 'string' && typeof r.label === 'string' && typeof r.status === 'string') rows.push(r)
      for (const v of Object.values(o)) walk(v)
    }
  }
  try {
    walk(JSON.parse(jsonText))
  } catch {
    return rows
  }
  return rows
}
function runChild(command: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...(opts.cwd ? { cwd: opts.cwd } : {}), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.on('exit', code => {
      clearTimeout(killer)
      resolve({ status: code, stdout, stderr })
    })
  })
}
async function doctorJson(): Promise<{ text: string; status: number | null }> {
  const res = await runChild('node', [BIN, 'doctor', '--json'], { cwd: CWD, timeoutMs: vshotBudgetMs(120_000) })
  return { text: res.stdout, status: res.status }
}

async function capture(name: string, cols: number, rows: number, sends: Array<Record<string, unknown>>, total: number): Promise<string[]> {
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
    return []
  }
  scenarios.writeSyntheticSession('short')
  const out = join(SCRATCH, `${name}.json`)
  const vcfg = { argv: ['node', BIN, '--resume', scenarios.SID], cwd: CWD, cols, rows, sends, total, out }
  const vcfgPath = join(SCRATCH, `${name}-cfg.json`)
  writeFileSync(vcfgPath, JSON.stringify(vcfg))
  const res = await runChild(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), vcfgPath], { timeoutMs: vshotBudgetMs(300_000) })
  check(`the ${name} capture ran`, res.status === 0, res.stderr.slice(-200))
  let lines: string[] = []
  try {
    const grid = JSON.parse(readFileSync(out, 'utf8')) as { grid: { c: string }[][] }
    lines = grid.grid.map(r => r.map(c => c.c || ' ').join(''))
  } catch {
    lines = []
  }
  const captureDir = process.env.MERCURY_HEALTH_CAPTURE_DIR
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true })
    writeFileSync(join(captureDir, `model-lists-doctor-${name}.txt`), lines.join('\n') + '\n')
    try {
      writeFileSync(join(captureDir, `model-lists-doctor-${name}.json`), readFileSync(out))
    } catch {
      console.log('  … the grid could not be copied beside the frame')
    }
  }
  return lines
}

const ESC = '\x1b'
try {
  console.log('J doctor --json (a fresh process holds no list): the row is present, info, and names every family')
  const j = await doctorJson()
  const rows = rowsOf(j.text)
  const row = rows.find(r => r.id === 'model-lists')
  check('doctor --json produced a certificate', j.status === 0 || j.status === 3, `status=${String(j.status)}`)
  check('the certificate carries the row "Model lists" in the AUTH section, after the usage rows', row !== undefined && row.label === 'Model lists' && rows.findIndex(r => r.id === 'model-lists') > rows.findIndex(r => r.id === 'usage-openai') && rows.findIndex(r => r.id === 'usage-openai') >= 0, rows.map(r => r.id).join(',').slice(0, 300))
  check('a fresh process has read no list: the row reads info (never a caution) with the approved evidence', row?.status === 'info' && row.evidence === 'no list read in this process — /model or a chat naming the family reads it; the release-day check reads every list · lists read 0 of 5', `${row?.status} · ${row?.evidence}`)
  const detail = row?.detail ?? ''
  check('the OpenAI line names the signed-in source and the typed count', detail.includes(`OpenAI · ChatGPT pro subscription · no list read in this process — /model or a chat naming the family reads it · ${GPT_DISPLAY_PINS.length} typed ids not judged`), detail)
  check('Z.AI reads its dated typed table (Z.AI publishes no model list)', /Z\.AI · no credential · no live list — typed table dated \d{4}-\d{2}-\d{2} · \d+ typed ids/.test(detail), detail)
  check('Anthropic reads no list read, naming the release-day check', /Anthropic · no list read \(Mercury reads no Anthropic list; the release-day check does\) · \d+ typed ids/.test(detail), detail)
  check('the families without a credential read not judged, Moonshot among them', /DeepSeek · no credential · \d+ typed ids not judged/.test(detail) && /Gemini · no credential · \d+ typed ids not judged/.test(detail) && /Hugging Face · no credential · \d+ typed ids not judged/.test(detail) && /Moonshot · no credential · \d+ typed ids not judged/.test(detail) && !/Moonshot · [^\n]*typed table dated/.test(detail), detail)
  check('no fix rides an info row', row !== undefined && row.fix === undefined)
  check('the headless doctor fetched no list', !hits.some(h => h.endsWith('/models')), hits.join(', '))
  const rowIndex = Math.max(0, rows.findIndex(r => r.id === 'model-lists'))

  for (const [cols, termRows] of [[120, 40], [80, 21]] as const) {
    console.log(`S the cockpit at ${cols}×${termRows} — /model reads the list, /health judges the typed ids against it`)
    const size = `${cols}x${termRows}`
    hits.length = 0
    const downs = Array.from({ length: rowIndex }, () => ({ afterPrevTicks: 1, data: '\x1b[B' }))
    const walk = rowIndex === 0 ? [] : [{ afterPrevTicks: 45, data: '\x1b[B' }, ...downs.slice(1)]
    const readyNeedle = cols >= 100 && termRows >= 26 ? '← back' : '1 session on'
    const lines = await capture(`row-${size}`, cols, termRows, [
      { atTick: 999, awaitText: readyNeedle, requireAwait: true, minTick: 5, awaitSettleTicks: 4, data: '/model' },
      { afterPrevTicks: 6, data: '\r' },
      { afterPrevTicks: 30, data: ESC },
      { afterPrevTicks: 12, data: '/health' },
      { afterPrevTicks: 6, data: '\r' },
      ...walk,
      { afterPrevTicks: 3, data: '\r' },
    ], 190 + rowIndex)
    check(`${size}: the picker read the fixture's list once`, hits.filter(h => h.endsWith('/openai/chatgpt/models')).length >= 1, hits.join(', '))
    check(`${size}: /health painted its certificate`, lines.some(l => l.includes('health certificate')))
    const rowLine = lines.find(l => l.includes('Model lists')) ?? ''
    check(`${size}: the Model lists row is on screen and warns`, rowLine.includes('▲') && rowLine.includes('Model lists'), rowLine.trim().slice(0, 120))
    const text = lines.map(line => line.replace(/^[│\s]+|[│\s]+$/g, '')).join(' ').replace(/\s+/g, ' ')
    check(`${size}: the evidence counts the served and not-served ids and names the family`, text.includes(`served ${OWNER_LIST.length} · not served ${RETIRED.length} (OpenAI)`), lines.filter(l => l.includes('served')).map(l => l.trim()).join(' | ').slice(0, 300))
    check(`${size}: the retired ids are named beneath the OpenAI line`, text.includes(`OpenAI not served: ${RETIRED.join(' · ')}`), lines.filter(l => l.includes('not served')).map(l => l.trim()).join(' | ').slice(0, 300))
  }
} catch (error) {
  failures++
  console.log(`  [FAIL] the drive threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  server.close()
  if (!process.argv.includes('--keep')) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`scratch kept at ${SCRATCH}`)
}
console.log(failures === 0 ? '✅ model lists doctor drive: all legs green' : `❌ model lists doctor drive: ${failures} leg(s) red`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = arg('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = arg('--frames')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'board-signin-')))
const CWD = join(ROOT, 'project')
mkdirSync(CWD)
const NODE = existsSync(join(dirname(BIN), 'vendor/node/bin/node')) ? join(dirname(BIN), 'vendor/node/bin/node') : 'node'
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`capture unavailable: ${driver.kind}`)
const ESC = '\x1b'
const SHIFT_RIGHT = `${ESC}[1;2C`
const SHIFT_LEFT = `${ESC}[1;2D`
const click = `${ESC}[<0;{X};{Y}M${ESC}[<0;{X};{Y}m`
const FIXTURE_KEY = 'AIzaFixtureBoardSignin0123456789abcdefghijk'
const FIXTURE_MODEL = 'Gemini Fixture Pro'
type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c).join('')).join('\n')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` ${detail}` : ''}`)
}
function gate(awaitText: string, data: string, mark?: string): Send {
  return { requireAwait: true, awaitText, awaitSettleTicks: 3, data, ...(mark ? { mark } : {}) }
}
function after(ticks: number, data: string, mark?: string): Send {
  return { afterPrevTicks: ticks, data, ...(mark ? { mark } : {}) }
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function endOwnedDaemon(home: string): Promise<void> {
  const record = join(home, 'daemon', 'supervisor.json')
  if (!existsSync(record)) return
  let pid = 0
  try {
    pid = Number((JSON.parse(readFileSync(record, 'utf8')) as { pid?: number }).pid ?? 0)
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 1) return
  for (let waited = 0; waited < 10_000 && pidAlive(pid); waited += 250) await sleep(250)
  if (!pidAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
  }
  for (let waited = 0; waited < 5_000 && pidAlive(pid); waited += 250) await sleep(250)
}
function startFixture(): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    const key = String(req.headers['x-goog-api-key'] ?? '')
    hits.push(`${req.method ?? ''} ${url}${key ? ` key=${key}` : ''}`)
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    req.on('data', () => {})
    req.on('end', () => {
      if (req.method === 'GET' && url.startsWith('/v1beta/models')) {
        json(200, {
          models: [
            {
              name: 'models/gemini-fixture-pro',
              displayName: FIXTURE_MODEL,
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
            },
          ],
        })
        return
      }
      json(404, {})
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ port, hits, close: () => server.close() })
    })
  })
}
function capture(cfgPath: string, env: NodeJS.ProcessEnv, budgetMs: number): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.stdout.on('data', () => {})
    const wall = setTimeout(() => {
      stderr += '\nthe capture wall was reached; the engine was killed'
      child.kill('SIGKILL')
    }, budgetMs)
    child.on('exit', code => {
      clearTimeout(wall)
      resolve({ status: code, stderr })
    })
  })
}
const fixture = await startFixture()
try {
  console.log(`bundle ${BIN}; scratch ${ROOT}; gemini fixture on 127.0.0.1:${fixture.port}`)
  for (const [cols, rows] of [[120, 40], [178, 51]]) {
    for (const kind of ['default', 'session', 'face', 'signin', 'roster']) {
      const id = `${kind}-${cols}x${rows}`
      const home = join(ROOT, id)
      seedFirstRun(home, [CWD])
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false, availableModels: kind === 'signin' || kind === 'roster' ? ['claude-opus-5', 'gemini'] : ['claude-opus-5'] }))
      const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'), MERCURY_TABULA_DIR: join(home, 'tabula'), MERCURY_HOME: join(home, 'home'), MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'), MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0', TERM_PROGRAM: 'vscode', MERCURY_IDE_SKIP_AUTO_INSTALL: '1', MERCURY_GEMINI_API_BASE: kind === 'signin' || kind === 'roster' ? `http://127.0.0.1:${fixture.port}/v1beta` : 'http://127.0.0.1:1' }
      for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'NODE_ENV']) delete env[k]
      const row = kind === 'signin' ? 'Gemini — sign in' : 'GPT — sign in'
      const geminiRow = 'Google Gemini — API key or Google OAuth'
      const family = kind === 'signin' ? `❯ ${geminiRow}` : '❯ OpenAI — ChatGPT subscription or API key'
      const keyLeg = [gate('the easiest: create one', '\r', 'pick'), gate('↵ store key', FIXTURE_KEY, 'key'), after(3, '\r'), gate('Gemini API key stored', '', 'receipt'), after(2, '\r'), after(12, '', 'returned')]
      const sends: Send[] = kind === 'face' || kind === 'roster' ? [] : [gate('↑↓ choose', SHIFT_RIGHT), gate('coordinator model', '\t'), gate('n new session', kind === 'session' ? 'n' : 'm')]
      if (kind === 'session') sends.push(gate('contract?', ESC), gate('← back', SHIFT_LEFT), gate('STATUS & TITLE', 'm'))
      if (kind === 'roster') {
        sends.push({ ...gate('↑↓ choose', click, 'face'), targetText: '⚿ Logins' }, after(4, '\r'), { ...gate('↵ sign in · esc back', click, 'landed'), targetText: geminiRow }, after(4, '\r'), ...keyLeg)
      } else {
        if (kind === 'face') sends.push(gate('↑↓ choose', 'm'))
        sends.push({ ...gate(row, click, 'picker'), targetText: row })
        sends.push(after(4, '\r', 'selected'), after(12, '', 'landed'))
        if (kind === 'signin') sends.push(gate('↵ sign in · esc back', '\r'), ...keyLeg)
        else sends.push(gate('↵ sign in · esc back', ESC), after(10, '', 'returned'))
      }
      const out = join(ROOT, `${id}.json`)
      const cfg = join(ROOT, `${id}.cfg.json`)
      writeFileSync(cfg, JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols, rows, total: kind === 'signin' || kind === 'roster' ? 480 : 360, sends, stableTicks: 3, out }))
      const hitsBefore = fixture.hits.length
      const result = await capture(cfg, env, vshotBudgetMs(kind === 'signin' || kind === 'roster' ? 240_000 : 180_000))
      await endOwnedDaemon(home)
      const captured = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; marks: Array<{ label: string; grid: Grid }> } : null
      const marks = new Map(captured?.marks.map(m => [m.label, textOf(m.grid)]) ?? [])
      const landed = marks.get('landed') ?? ''
      const returned = marks.get('returned') ?? ''
      const excerpt = (text: string): string => text.split('\n').filter(l => l.trim()).slice(0, 8).join('\n')
      const receipt = marks.get('receipt') ?? ''
      const keepFrames = (): void => {
        if (!FRAMES) return
        mkdirSync(FRAMES, { recursive: true })
        if (captured) writeFileSync(join(FRAMES, `${id}.json`), JSON.stringify(captured))
        for (const [mark, text] of marks) writeFileSync(join(FRAMES, `${id}-${mark}.txt`), text + '\n')
      }
      check(`${id}: every send delivered`, result.status === 0, result.stderr.slice(-600))
      if (kind === 'roster') {
        const hits = fixture.hits.slice(hitsBefore)
        check(`${id}: the face's own Logins row opened the sign-in layer`, (marks.get('face') ?? '').includes('⚿ Logins') && landed.includes('LOGINS') && landed.includes('Families'), excerpt(landed))
        check(`${id}: the pasted key was proved on the live catalogue with the key itself`, hits.some(h => h.startsWith('GET /v1beta/models') && h.includes(`key=${FIXTURE_KEY}`)) && receipt.includes('Gemini API key stored'), hits.join(' | ') || excerpt(receipt))
        check(`${id}: the receipt pane's way out reads the roster when no picker opened the door`, receipt.includes('↵ done — the roster refreshes') && !receipt.includes('back to the picker'), receipt.split('\n').filter(l => l.includes('↵ done')).join('\n'))
        check(`${id}: the completed sign-in stays on the roster, the family signed in`, returned.includes('LOGINS') && returned.includes('Families') && returned.includes('Signed in  2 of 8') && !returned.includes('Mercury — model'), excerpt(returned))
        keepFrames()
        continue
      }
      check(`${id}: connect row selected in the model picker`, (marks.get('selected') ?? '').includes(row) && (marks.get('picker') ?? '').includes('Mercury — model'))
      check(`${id}: the sign-in layer is open`, landed.includes('LOGINS') && landed.includes('Families'), excerpt(landed))
      check(`${id}: the sign-in layer opened on the chosen row's family`, landed.includes(family), landed.split('\n').filter(l => l.includes('❯')).join('\n'))
      if (kind === 'signin') {
        const hits = fixture.hits.slice(hitsBefore)
        check(`${id}: the pasted key was proved on the live catalogue with the key itself`, hits.some(h => h.startsWith('GET /v1beta/models') && h.includes(`key=${FIXTURE_KEY}`)) && receipt.includes('Gemini API key stored'), hits.join(' | ') || excerpt(receipt))
        check(`${id}: the receipt pane's way out names the picker that opened the door`, receipt.includes('↵ done — back to the picker'), receipt.split('\n').filter(l => l.includes('↵ done')).join('\n'))
        check(`${id}: the completed sign-in returned to the picker that opened it, on the board`, returned.includes('Mercury — model') && returned.includes('SESSION CONCOURSE'), excerpt(returned))
        check(`${id}: the returned picker lists the new family's live rows`, returned.includes(FIXTURE_MODEL), returned.split('\n').filter(l => l.includes('GEMINI') || l.includes('Gemini')).join('\n'))
      } else {
        const beneath = kind === 'face' ? 'Doctor / Health Check' : 'SESSION CONCOURSE'
        check(`${id}: escape returned to the picker that opened it, ${kind === 'face' ? 'on the face' : 'on the board'}`, returned.includes('Mercury — model') && returned.includes(beneath), excerpt(returned))
      }
      keepFrames()
    }
  }
} finally {
  fixture.close()
  rmSync(ROOT, { recursive: true, force: true })
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

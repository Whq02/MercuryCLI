#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = arg('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = arg('--frames')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-plan-drive-')))
const CWD = join(ROOT, 'project')
mkdirSync(CWD)
const NODE = existsSync(join(dirname(BIN), 'vendor/node/bin/node')) ? join(dirname(BIN), 'vendor/node/bin/node') : 'node'
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`capture unavailable: ${driver.kind}`)
const ESC = '\x1b'
const SHIFT_RIGHT = `${ESC}[1;2C`
const click = `${ESC}[<0;{X};{Y}M${ESC}[<0;{X};{Y}m`
const PLAN_ROW = "Sign in with Google — your plan's quota: AI Pro, AI Ultra or a free account"
const GEMINI_ROW = 'Google Gemini — Google sign-in, API key'
const EMAIL = 'owner@example.invalid'
type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c).join('')).join('\n')
const gone = (words: string): string => `\\A(?![\\s\\S]*${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` ${detail}` : ''}`)
}
function gate(awaitText: string, data: string, mark?: string): Send {
  return { requireAwait: true, awaitText, awaitSettleTicks: 3, data, ...(mark ? { mark } : {}) }
}
function witness(awaitText: string, mark: string, awaitPattern?: string): Send {
  return { requireAwait: true, awaitText, ...(awaitPattern ? { awaitPattern } : {}), awaitSettleTicks: 3, data: '', mark }
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function untilGone(pid: number, dir: string, ceilingMs: number): Promise<void> {
  if (!pidAlive(pid)) return
  try {
    for await (const _event of watch(dir, { signal: AbortSignal.timeout(ceilingMs) })) {
      if (!pidAlive(pid)) return
    }
  } catch {
  }
}
async function endOwnedDaemon(home: string): Promise<void> {
  const dir = join(home, 'daemon')
  const record = join(dir, 'daemon.json')
  if (!existsSync(record)) return
  let pid = 0
  try {
    pid = Number((JSON.parse(readFileSync(record, 'utf8')) as { pid?: number }).pid ?? 0)
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 1) return
  await untilGone(pid, dir, vshotBudgetMs(10_000))
  if (!pidAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
  }
  await untilGone(pid, dir, vshotBudgetMs(5_000))
}
type Hit = { method: string; url: string; auth: string; agent: string; body: string }
function startFixture(): Promise<{ port: number; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = []
  const PRO = { id: 'g1-pro-tier', name: 'Google AI Pro' }
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      hits.push({ method: req.method ?? '', url, auth: String(req.headers.authorization ?? ''), agent: String(req.headers['user-agent'] ?? ''), body })
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body).entries())
        json(200, { access_token: `ya29.plan-fixture-${form.grant_type === 'refresh_token' ? 'refreshed' : 'first'}`, ...(form.grant_type === 'refresh_token' ? {} : { refresh_token: '1//refresh-fixture' }), expires_in: 3600, token_type: 'Bearer', scope: 'x' })
        return
      }
      if (url.startsWith('/oauth2/v1/userinfo')) {
        json(200, { email: EMAIL, verified_email: true })
        return
      }
      if (!String(req.headers.authorization ?? '').startsWith('Bearer ya29.plan-fixture')) {
        json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
        return
      }
      if (url === '/v1internal:loadCodeAssist') {
        json(200, { currentTier: PRO, paidTier: PRO, allowedTiers: [{ id: 'free-tier', name: 'Free', isDefault: true }, PRO], cloudaicompanionProject: 'project-fixture-123' })
        return
      }
      if (url === '/v1internal:fetchAvailableModels') {
        json(200, { models: { 'gemini-4-argon': { displayName: 'Gemini 4 Argon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 0.8, resetTime: '2026-10-15T00:00:00Z' } }, 'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 } }, imageGenerationModelIds: [], agentModelSorts: [] })
        return
      }
      if (url === '/v1internal:streamGenerateContent?alt=sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end([
          `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'OK from the plan fixture.' }] } }] } })}\n\n`,
          `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 } } })}\n\n`,
        ].join(''))
        return
      }
      json(404, { error: { code: 404, message: `no fixture road for ${url}`, status: 'NOT_FOUND' } })
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
const browser = join(ROOT, 'browser.sh')
writeFileSync(browser, ['#!/bin/sh', 'url="$1"', `state=$(printf '%s' "$url" | sed -n 's/.*[?&]state=\\([^&]*\\).*/\\1/p')`, `(i=0; while [ ! -s "$MERCURY_CLIPBOARD_FILE" ] && [ "$i" -lt 300 ]; do sleep 0.05; i=$((i + 1)); done; curl -s "http://127.0.0.1:51121/oauth-callback?code=OK&state=$state" >/dev/null 2>&1) &`, 'exit 0', ''].join('\n'))
chmodSync(browser, 0o755)
try {
  console.log(`bundle ${BIN}; scratch ${ROOT}; Google + Code Assist fixture on 127.0.0.1:${fixture.port}`)
  for (const [cols, rows] of [[120, 40], [178, 51]]) {
    const id = `plan-${cols}x${rows}`
    const home = join(ROOT, id)
    seedFirstRun(home, [CWD])
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } }, engine: { roster: ['claude-opus-5', 'gemini'] } }))
    const base = `http://127.0.0.1:${fixture.port}`
    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: FIXTURE_API_KEY, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: browser, MERCURY_CLIPBOARD_FILE: join(home, 'clipboard.txt'), MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_HOME: join(home, 'home'), MERCURY_HEALTH_STATE_DIR: join(home, 'health'), MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0', TERM_PROGRAM: 'vscode', MERCURY_GEMINI_API_BASE: 'http://127.0.0.1:1', MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/token`, MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/auth`, MERCURY_GOOGLE_USERINFO_BASE: base, MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE: base, MERCURY_ANTIGRAVITY_MANIFEST_BASE: 'http://127.0.0.1:1' }
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'NODE_ENV']) delete env[k]
    const sends: Send[] = [
      gate('↑↓ choose', SHIFT_RIGHT),
      gate('coordinator model', '\t'),
      gate('n new session', 'm'),
      { ...gate('Gemini — sign in', click, 'picker'), targetText: 'Gemini — sign in' },
      gate('Gemini — sign in', '\r', 'selected'),
      witness(`❯ ${GEMINI_ROW}`, 'landed'),
      gate('↵ sign in · esc back', '\r'),
      witness("your plan's quota", 'card'),
      gate("your plan's quota", '\r'),
      gate('If nothing opened, visit:', 'c', 'wait'),
      witness('Gemini connected: Google sign-in', 'receipt'),
      gate('↵ returns to the picker', '\r'),
      witness(`GEMINI · Google sign-in · ${EMAIL}`, 'returned'),
      gate('Gemini 4 Argon', '\r', 'picked'),
      witness('gemini-4-argon', 'model', gone('Mercury · model')),
      gate('n new session', ESC),
      witness('↑↓ choose', 'end'),
    ]
    const out = join(ROOT, `${id}.json`)
    const cfg = join(ROOT, `${id}.cfg.json`)
    writeFileSync(cfg, JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols, rows, total: 560, sends, readyText: '↑↓ choose', stableTicks: 3, out }))
    const hitsBefore = fixture.hits.length
    const result = await capture(cfg, env, vshotBudgetMs(280_000))
    await endOwnedDaemon(home)
    const captured = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }> } : null
    const marks = new Map(captured?.marks?.map(m => [m.label, textOf(m.grid)]) ?? [])
    const excerpt = (text: string): string => text.split('\n').filter(l => l.trim()).slice(0, 10).join('\n')
    const flat = (text: string): string => text.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ').trim()
    const rightPane = (text: string): string => text.split('\n').map(line => { const cells = line.split('│'); return cells.length >= 4 ? cells[cells.length - 2]! : '' }).join(' ').replace(/\s+/g, ' ').trim()
    const hits = fixture.hits.slice(hitsBefore)
    if (FRAMES) {
      mkdirSync(FRAMES, { recursive: true })
      if (captured) writeFileSync(join(FRAMES, `${id}.json`), JSON.stringify(captured))
      for (const [mark, text] of marks) writeFileSync(join(FRAMES, `${id}-${mark}.txt`), text + '\n')
    }
    check(`${id}: every send delivered`, result.status === 0, result.stderr.slice(-800))
    const landed = marks.get('landed') ?? ''
    check(`${id}: the sign-in layer opened on the Gemini family`, landed.includes('LOGINS') && landed.includes(`❯ ${GEMINI_ROW}`), excerpt(landed))
    const card = marks.get('card') ?? ''
    check(`${id}: the Gemini card offers Sign in with Google first, the key second, the own client third`, card.includes(PLAN_ROW.slice(0, 40)) && card.indexOf('Sign in with Google') >= 0 && card.indexOf('Sign in with Google') < card.indexOf('API key — the easiest') && card.includes('Google account — six steps'), excerpt(card))
    const wait = rightPane(marks.get('wait') ?? '')
    check(`${id}: the browser wait says what Sign in with Google is and where the page opened`, wait.includes("Sign in with Google: Google's sign-in page opens in your browser") && wait.includes("Google's own Antigravity client") && wait.includes('If nothing opened, visit:'), excerpt(marks.get('wait') ?? ''))
    const exchange = hits.find(h => h.url === '/token')
    check(`${id}: the loopback callback the browser completed was exchanged with the Antigravity client, then the e-mail and the tier read under the Antigravity User-Agent`, exchange !== undefined && exchange.body.includes('client_id=1071006060591') && exchange.body.includes('code_verifier=') && hits.some(h => h.url.startsWith('/oauth2/v1/userinfo')) && hits.some(h => h.url === '/v1internal:loadCodeAssist' && h.agent.startsWith('antigravity/hub/') && h.body.includes('"ideType":"ANTIGRAVITY"')), hits.map(h => `${h.method} ${h.url} ua=${h.agent}`).join(' | '))
    const receipt = rightPane(marks.get('receipt') ?? '')
    check(`${id}: the receipt names the e-mail, the tier, the active source and the roster count, and the family reads signed in`, receipt.includes(`Gemini connected: Google sign-in as ${EMAIL} on Google AI Pro — the active source`) && receipt.includes("Google's Code Assist endpoint under Google's own Antigravity client") && receipt.includes('2 chat model(s) on the roster') && flat(marks.get('receipt') ?? '').includes('Signed in 2 of'), excerpt(marks.get('receipt') ?? ''))
    check(`${id}: the roster was read with fetchAvailableModels under the Antigravity User-Agent`, hits.some(h => h.url === '/v1internal:fetchAvailableModels' && h.agent.startsWith('antigravity/hub/')))
    const returned = flat(marks.get('returned') ?? '')
    check(`${id}: the picker that opened the door lists the roster under the Google sign-in with the e-mail, gemini-4-argon current with its stated window`, returned.includes(`GEMINI · Google sign-in · ${EMAIL} · 2 live`) && /Gemini 4 Argon gemini-4-argon current 1\.05M ctx/.test(returned) && returned.includes('Gemini 3.5 Flash gemini-3.5-flash-low'), excerpt(marks.get('returned') ?? ''))
    const model = flat(marks.get('model') ?? '')
    check(`${id}: ↵ on gemini-4-argon takes the roster row and the picker closes without a refusal`, !model.includes('Mercury · model') && !model.includes('API Error') && !model.includes('RENDER ERROR'), excerpt(marks.get('model') ?? ''))
    check(`${id}: nothing left the box for anything but the fixture`, hits.every(h => !h.url.includes('generativelanguage') && !h.url.includes('/openai/')))
    const authFile = join(home, '.gemini-auth.json')
    const stored = existsSync(authFile) ? JSON.parse(readFileSync(authFile, 'utf8')) as { plan?: { projectId?: string; email?: string; tokens?: { refreshToken?: string } }; preferredSource?: string } : {}
    check(`${id}: the grant is stored auth-scoped with the project, the e-mail and a refresh token, as the active source`, stored.plan?.projectId === 'project-fixture-123' && stored.plan.email === EMAIL && stored.plan.tokens?.refreshToken === '1//refresh-fixture' && stored.preferredSource === 'plan', JSON.stringify({ ...stored, plan: stored.plan ? { ...stored.plan, tokens: 'masked' } : undefined }))
  }
} finally {
  fixture.close()
  rmSync(ROOT, { recursive: true, force: true })
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

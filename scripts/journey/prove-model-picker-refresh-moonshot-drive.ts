#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
const SIZES = (arg('--sizes') ?? '178x51').split(',').map(size => size.split('x').map(Number) as [number, number])
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), arg('--scratch-prefix') ?? 'model-refresh-moonshot-')))
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
const DEAD = 'http://127.0.0.1:1'
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
if (!existsSync(DIST)) throw new Error(`Build missing: ${DIST}`)
if (FRAMES) mkdirSync(FRAMES, { recursive: true })
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}
type Cell = { c?: string }
type Grid = Cell[][]
type Payload = { grid: Grid; marks?: { label: string; grid: Grid; atMs: number }[]; sendReceipts?: { ts: number }[]; endReason?: string }
type Wire = { kind: string; phase?: string; model?: string; status?: number; path?: string; at: number }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const live = (frame: string, name: string): boolean => new RegExp(`│ (?:│ | {2})(?:❯ )?${escapeRe(name)} {2,}\\S`).test(frame)
const current = (frame: string, name: string): boolean => new RegExp(`${escapeRe(name)} {2,}\\S+ {2,}current`).test(frame)
const headingOf = (frame: string, title: string): string => (frame.split('\n').find(line => line.includes(title)) ?? '').replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').trim()

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const nowS = Math.floor(Date.now() / 1000)
const TOKEN = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'fixture-subject-plan', iat: nowS, exp: nowS + 86_400 })}.fixture-signature`
const ALIAS = 'kimi-for-coding'
const FAST = 'kimi-for-coding-highspeed'
const ALIAS_NAME = 'Kimi for Coding'
const K3_NAME = 'K3'
const K3_256K_NAME = 'K3 256K'
const MOONSHOT_TITLE = ' MOONSHOT · '
const NOTICE = 'Moonshot — the live list changed; rows updated'
const OLD_LIST = { object: 'list', data: [
  { id: FAST, object: 'model', created: 200, owned_by: 'moonshot', context_length: 262_144 },
  { id: ALIAS, object: 'model', created: 100, owned_by: 'moonshot', context_length: 262_144, display_name: ALIAS_NAME },
] }
const PLAN_LIST = { object: 'list', data: [
  { id: FAST, object: 'model', created: 400, owned_by: 'moonshot', context_length: 262_144 },
  { id: ALIAS, object: 'model', created: 300, owned_by: 'moonshot', context_length: 262_144, display_name: ALIAS_NAME },
  { id: 'k3-256k', object: 'model', created: 200, owned_by: 'moonshot' },
  { id: 'k3', object: 'model', created: 100, owned_by: 'moonshot' },
] }
console.log(`bundle ${DIST}\nscratch ${SCRATCH}`)

for (const [cols, rows] of SIZES) {
  const tag = `kimi-open-${cols}x${rows}`
  const home = join(SCRATCH, tag)
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), '{}')
  writeFileSync(join(home, '.sign-ins.json'), JSON.stringify({ version: 1, signIns: { moonshot: { kind: 'oauth', at: Date.now() } } }))
  writeFileSync(join(home, '.moonshot-auth.json'), JSON.stringify({ version: 1, region: 'global', tokens: { accessToken: TOKEN, refreshToken: 'fixture-refresh-plan', accessTokenExpiresAtMs: Date.now() + 86_400_000 } }), { mode: 0o600 })
  const ledger = join(home, 'wire.jsonl')
  writeFileSync(ledger, '')
  const record = (entry: Record<string, unknown>): void => appendFileSync(ledger, JSON.stringify({ ...entry, at: Date.now() }) + '\n')
  let turned = false
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
  const fixture = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fixture').pathname
      const method = req.method ?? 'GET'
      const answer = (status: number, body: string, type = 'application/json'): void => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        record({ kind: 'refused', method, path, status: 401 })
        return answer(401, JSON.stringify({ error: { message: 'fixture refuses the credential' } }))
      }
      const phase = turned ? 'after' : 'before'
      if (method === 'GET' && path === '/coding/v1/models') {
        record({ kind: 'models', phase, status: 200 })
        return answer(200, JSON.stringify(phase === 'after' ? PLAN_LIST : OLD_LIST))
      }
      if (method === 'POST' && path === '/coding/v1/chat/completions') {
        let model = ''
        try {
          model = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }).model ?? '')
        } catch {
          model = ''
        }
        const served = (phase === 'after' ? PLAN_LIST : OLD_LIST).data.some(row => row.id === model)
        if (!served) {
          record({ kind: 'turn', model, status: 404 })
          return answer(404, JSON.stringify({ error: { code: 'resource_not_found_error', message: `fixture refuses model ${model}` } }))
        }
        record({ kind: 'turn', model, status: 200 })
        turned = true
        const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown): string => sse({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 200, model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })
        return answer(200, chunk({ role: 'assistant', content: 'fixture catalogue answer' }, null) + chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }) + 'data: [DONE]\n\n', 'text/event-stream')
      }
      record({ kind: 'hit', method, path, status: 404 })
      return answer(404, JSON.stringify({ error: { message: `fixture: no route ${path}` } }))
    })
  })
  await new Promise<void>(resolvePort => fixture.listen(0, '127.0.0.1', resolvePort))
  try {
    const address = fixture.address()
    if (!address || typeof address === 'string') throw new Error('fixture has no port')
    const base = `http://127.0.0.1:${address.port}`
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, TMPDIR: realpathSync(tmpdir()),
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor',
      MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: DEAD, MERCURY_CUSTOM_OAUTH_URL: DEAD,
      MERCURY_OPENAI_API_BASE: DEAD, MERCURY_OPENAI_AUTH_BASE: DEAD, MERCURY_OPENAI_CHATGPT_BASE: DEAD,
      MERCURY_OPENROUTER_API_BASE: DEAD, MERCURY_OPENROUTER_AUTH_BASE: DEAD,
      MERCURY_GEMINI_API_BASE: DEAD, MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD, MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
      MERCURY_ZAI_API_BASE: DEAD, MERCURY_MOONSHOT_API_BASE: DEAD, MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
      MERCURY_MOONSHOT_CODING_BASE: `${base}/coding/v1`,
      MERCURY_DEEPSEEK_API_BASE: DEAD, MERCURY_HUGGINGFACE_API_BASE: DEAD, MERCURY_HUGGINGFACE_HUB_BASE: DEAD, MERCURY_UPDATE_API_BASE_URL: DEAD,
      MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'), MERCURY_TABULA_DIR: join(home, 'tabula'),
      MERCURY_HOME: join(home, 'proof-home'), MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'), MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0',
      MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
      MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TERMINAL_TITLE: '0', MERCURY_UPDATE_NOTICE: '0', MERCURY_OPERATOR: 'sam', MERCURY_CAP_FAILOVER: '0',
    }
    const out = join(home, 'grid.json')
    const cfg = join(home, 'cfg.json')
    const wide = cols >= 100 && rows >= 26
    const landed = wide ? '← back' : '1 session on'
    const ready = wide ? 'ready · ' : '1 session on'
    const sends = [
      { requireAwait: true, awaitText: 'New Session', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: landed, minTick: 10, awaitSettleTicks: 3, data: 'hello\r', mark: 'default' },
      { requireAwait: true, awaitText: 'fixture ', minTick: 4, awaitSettleTicks: 3, data: '', mark: 'chat' },
      { requireAwait: true, awaitText: ready, minTick: 3, awaitSettleTicks: 3, data: '/model\r', mark: 'open' },
      { requireAwait: true, awaitText: 'Mercury · model', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'opened' },
      { afterPrevTicks: 40, awaitText: '· 4 live', awaitSettleTicks: 3, data: '', mark: 'live' },
    ]
    writeFileSync(cfg, JSON.stringify({ argv: [NODE, DIST], cwd, cols, rows, total: 400, sends, out, stableTicks: 4 }))
    const status = await new Promise<number>((resolveCapture, reject) => {
      execFile(driver.python, [captureEngineEntry(driver, ROOT), cfg], { env, cwd, windowsHide: true, timeout: vshotBudgetMs(180_000) }, (error, stdout, stderr) => {
        writeFileSync(join(home, 'capture.log'), stdout + stderr)
        if (error && !existsSync(out)) reject(new Error(`${error}\n${stderr}`))
        else resolveCapture(error ? Number(error.code) || 1 : 0)
      })
    })
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    const wire = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire)
    const markOf = (label: string): string => { const mark = payload.marks?.find(m => m.label === label); return mark ? text(mark.grid) : '' }
    const opened = markOf('opened')
    const liveFrame = markOf('live') || text(payload.grid)
    if (FRAMES) {
      for (const label of ['default', 'chat', 'open', 'opened', 'live']) writeFileSync(join(FRAMES, `${tag}-${label}.txt`), markOf(label) + '\n')
      writeFileSync(join(FRAMES, `${tag}-final.txt`), text(payload.grid) + '\n')
      writeFileSync(join(FRAMES, `${tag}-grid.json`), JSON.stringify(payload))
      writeFileSync(join(FRAMES, `${tag}-wire.jsonl`), readFileSync(ledger))
    }
    const sendIndex = (mark: string): number => sends.findIndex(send => (send as { mark?: string }).mark === mark)
    const receiptAt = (mark: string): number => payload.sendReceipts?.[sendIndex(mark)]?.ts ?? Infinity
    const openAt = receiptAt('open')
    const liveAt = receiptAt('live')
    const models = wire.filter(event => event.kind === 'models')
    const turn = wire.find(event => event.kind === 'turn')
    const turnAt = turn?.at ?? Infinity
    const atBirth = models.filter(event => event.at < turnAt)
    const between = models.filter(event => event.at >= turnAt && event.at < openAt)
    const afterOpen = models.filter(event => event.at >= openAt)
    const headingLine = headingOf(liveFrame, MOONSHOT_TITLE)
    const planRows = [K3_NAME, K3_256K_NAME].filter(name => live(liveFrame, name))
    console.log(`[record] ${tag}: reads at birth ${atBirth.length} · turn ${turn ? `${turn.model} (${turn.status})` : 'none'} · reads between ${between.length} · reads after open ${afterOpen.map(event => event.phase).join(',') || 'none'} · heading "${headingLine}" · plan rows ${planRows.join(',') || 'none'}`)
    check(`${tag}: the drive reached every state`, status === 0 && payload.sendReceipts?.length === sends.length, `${payload.sendReceipts?.length}/${sends.length}; ${payload.endReason}`)
    check(`${tag}: every fixture request carried the sign-in's bearer`, !wire.some(event => event.kind === 'refused'), JSON.stringify(wire.filter(event => event.kind === 'refused')))
    check(`${tag}: the birth read the account's list before the first turn`, atBirth.length >= 1 && atBirth.every(event => event.phase === 'before'), `reads at birth ${atBirth.length}`)
    check(`${tag}: the first turn ran the list's head, ${ALIAS}, on the fixture`, turn?.model === ALIAS && turn.status === 200, JSON.stringify(turn))
    check(`${tag}: nothing polls the list between the turn and the open`, between.length === 0, `reads ${between.length}`)
    check(`${tag}: the open makes exactly one list request before any keypress`, afterOpen.length === 1 && afterOpen[0]!.phase === 'after' && afterOpen[0]!.at <= liveAt, `reads after open ${afterOpen.length} (${afterOpen.map(event => event.phase).join(',')}); liveAt ${liveAt}`)
    check(`${tag}: the picker opened on the session's own row`, opened.includes('Mercury · model') && (!wide || current(opened, ALIAS_NAME)), opened.split('\n').filter(line => line.includes(ALIAS_NAME)).join(' | '))
    check(`${tag}: the Moonshot block is live on open: the plan's K3 rows paint around the current row`, planRows.length >= (wide ? 2 : 1) && current(liveFrame, ALIAS_NAME), liveFrame.split('\n').filter(line => /K3|Kimi/.test(line)).join(' | '))
    check(`${tag}: the heading reads the sign-in door with the live count`, /^[▾❯] MOONSHOT · Kimi login(?: · \S+)? · 4 live$/.test(headingLine), headingLine)
    check(`${tag}: the changed list paints the family's notice`, liveFrame.includes(NOTICE), liveFrame.split('\n').filter(line => line.includes('Moonshot')).join(' | '))
    check(`${tag}: the current row keeps the session's model beside its raw id`, new RegExp(`${escapeRe(ALIAS_NAME)} {2,}${escapeRe(ALIAS)} {2,}current`).test(liveFrame) || !wide, liveFrame.split('\n').filter(line => line.includes(ALIAS)).join(' | '))
  } finally {
    fixture.closeAllConnections()
    await new Promise<void>(resolveClose => fixture.close(() => resolveClose()))
  }
}
console.log(`${checks} checks, ${failures} failures; worlds kept at ${SCRATCH}`)
process.exit(failures === 0 ? 0 : 1)

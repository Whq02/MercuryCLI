#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
const SIZES = (arg('--sizes') ?? '120x40,80x21').split(',').map(size => size.split('x').map(Number) as [number, number])
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'

const WORLD_ROOT = '/private/tmp/mw'
mkdirSync(WORLD_ROOT, { recursive: true })
const SCRATCH = realpathSync(mkdtempSync(join(WORLD_ROOT, 'stream-cut-')))
const work = join(SCRATCH, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# stream cut fixture\n')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'import-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL']) {
  delete process.env[k]
}
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

const GPT_ID = 'gpt-6-astra'
const PROMPT = 'tell the story'
const PARTIAL = 'Once upon a time, the first half of the story, '
const CONTINUED = 'and the second half ends well.'
const NUDGE_MARK = 'dropped mid-response after partial content'
const CALM_LINE = 'Continued after 1 stream cut · context sent again'
const FAULT_WORDS = 'stream fault after partial content (read-failed) — terminated'
type Seen = { n: number; last: string; cut: boolean; continuation: boolean }
const requests: Seen[] = []
let cutArmed = false
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const userTexts = (body: Record<string, unknown>): string => {
  const input = body.input
  if (!Array.isArray(input)) return ''
  const texts: string[] = []
  for (const item of input as Array<{ role?: string; content?: unknown }>) {
    if (!item || item.role !== 'user') continue
    const c = item.content
    if (typeof c === 'string') texts.push(c)
    else if (Array.isArray(c)) texts.push(c.map(part => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join(' '))
  }
  return texts.join('\n')
}
const textTurn = (text: string): string => {
  const rid = `resp_cut_${Date.now()}`
  return (
    sse({ type: 'response.created', response: { id: rid } }) +
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) +
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 40, output_tokens: 9 } } })
  )
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [
            {
              slug: GPT_ID,
              display_name: 'GPT-6 Astra',
              visibility: 'list',
              priority: 1,
              supported_reasoning_levels: ['low', 'medium', 'high'],
              default_reasoning_level: 'medium',
              context_window: 272_000,
              max_context_window: 872_000,
              input_modalities: ['text', 'image'],
              supported_in_api: true,
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      const texts = userTexts(body)
      const continuation = texts.includes(NUDGE_MARK)
      const cut = cutArmed && !continuation && texts.includes(PROMPT)
      requests.push({ n: requests.length + 1, last: texts.slice(-80), cut, continuation })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cf-ray': 'fixture-ray-0001-LHR' })
      if (cut) {
        cutArmed = false
        const rid = `resp_cut_${Date.now()}`
        res.write(sse({ type: 'response.created', response: { id: rid } }))
        res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_cut', type: 'message', role: 'assistant', content: [] } }))
        res.write(sse({ type: 'response.output_text.delta', item_id: 'msg_cut', output_index: 0, content_index: 0, delta: PARTIAL }))
        setTimeout(() => res.socket?.destroy(), 400)
        return
      }
      res.end(textTurn(continuation ? CONTINUED : 'ok'))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
const port = await new Promise<number>(resolveRun => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolveRun(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
const base = `http://127.0.0.1:${port}`

function seedHome(name: string): string {
  const home = join(SCRATCH, name)
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [work])
  writeFileSync(join(home, 'settings.json'), '{}\n')
  const now = Date.now()
  const authFile = join(home, '.openai-auth.json')
  writeFileSync(
    authFile,
    JSON.stringify(
      {
        version: 1,
        tokens: {
          idToken: 'fixture-id-cut',
          accessToken: 'fixture-access-cut',
          refreshToken: 'fixture-refresh-cut',
          accountId: 'acct-fixture-cut',
          planType: 'pro',
          email: 'ana@example.com',
          accessTokenExpiresAtMs: now + 86_400_000,
        },
        lastRefreshMs: now,
        preferredSource: 'chatgpt-subscription',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  chmodSync(authFile, 0o600)
  recordSignIn('openai', 'subscription', { home })
  return home
}

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_OPERATOR: 'sam',
    DEBUG: '1',
    MERCURY_MODEL: GPT_ID,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:9',
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    BROWSER: '/usr/bin/true',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    COLORTERM: 'truecolor',
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

type Send = Record<string, unknown>
type Cell = { c?: string; fg?: string; bold?: boolean }
type Grid = Cell[][]
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
const rowCells = (grid: Grid, needle: string): Cell[] | null => {
  for (const row of grid) {
    const text = row.map(c => c.c ?? ' ').join('')
    const at = text.indexOf(needle)
    if (at >= 0) return row.slice(at, at + needle.length)
  }
  return null
}
async function capture(tag: string, home: string, cols: number, rows: number, sends: Send[], readyText: string): Promise<{ marks: Record<string, string>; grids: Record<string, Grid>; final: string; sends: number; receipts: number }> {
  const dir = join(SCRATCH, `capture-${tag}`)
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: [node, DIST], cwd: work, cols, rows, total: 500, sends, readyText: [readyText], stableTicks: 4, out: outPath }))
  const refusal = await new Promise<string | null>((resolveRun, rejectRun) => {
    execFile(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { env: childEnv(home), timeout: vshotBudgetMs(260_000) }, (error, _stdout, stderr) => {
      if (error && !existsSync(outPath)) rejectRun(new Error(`${String(error)}\n${stderr}`))
      else resolveRun(error ? String(stderr).split('\n').find(line => line.includes('[vshot]')) ?? String(error) : null)
    })
  })
  if (refusal !== null) console.log(`  (the capture ended refused: ${refusal.slice(0, 160)})`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }> }
  const marks: Record<string, string> = {}
  const grids: Record<string, Grid> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    grids[m.label] = m.grid
  }
  const final = gridText(payload.grid)
  if (FRAMES !== undefined) {
    for (const [label, text] of Object.entries(marks)) writeFileSync(join(FRAMES, `${tag}-${label}.txt`), text + '\n')
    writeFileSync(join(FRAMES, `${tag}-final.txt`), final + '\n')
  }
  return { marks, grids, final, sends: sends.length, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0 }
}

const FACE: Send = { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 }
const linesWith = (frame: string, needle: string): string[] => frame.split('\n').filter(line => line.includes(needle)).map(line => line.trim())

console.log('a GPT stream the provider cuts mid-text is continued once, and the transcript says so in one calm line — the built cockpit in a PTY')
console.log(`  bundle ${DIST}\n  fixture ${base}\n  scratch ${SCRATCH}`)

try {
  for (const [cols, rows] of SIZES) {
    const tag = `${cols}x${rows}`
    const home = seedHome(`home-${tag}`)
    const cockpit = cols >= 100 && rows >= 26
    console.log(`\n── ${tag}${cockpit ? '' : ' (the compact layout)'}`)
    const settled = cockpit ? '· ready' : '1 session on'
    const sends: Send[] = [
      FACE,
      { data: '', atTick: 999, awaitText: settled, requireAwait: true, minTick: 4, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'boot' },
      { data: `${PROMPT}\r`, atTick: 999, awaitText: settled, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
      { data: '', atTick: 999, awaitText: CONTINUED, requireAwait: true, minTick: 3, awaitSettleTicks: 8, awaitStableTicks: 4, mark: 'landed' },
      { data: '\x0f', atTick: 999, awaitText: CONTINUED, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
      { data: '', atTick: 999, awaitText: 'read-failed', requireAwait: true, minTick: 3, awaitSettleTicks: 6, awaitStableTicks: 3, mark: 'expanded' },
    ]
    const before = requests.length
    cutArmed = true
    let shot: Awaited<ReturnType<typeof capture>>
    try {
      shot = await capture(tag, home, cols, rows, sends, CONTINUED)
    } catch (err) {
      check(`${tag}: the capture ran`, false, err instanceof Error ? err.message.slice(0, 400) : String(err))
      continue
    }
    const seen = requests.slice(before)
    console.log(`  requests: ${JSON.stringify(seen)}`)
    check(`${tag}: every send became due`, shot.receipts === shot.sends, `${shot.receipts}/${shot.sends}`)
    check(`${tag}: the fixture cut one stream mid-text and answered the continuation`, seen.some(r => r.cut) && seen.some(r => r.continuation), JSON.stringify(seen))
    const landed = shot.marks.landed ?? ''
    check(`${tag}: the partial text stands and the continuation followed it`, landed.includes(PARTIAL.trim()) && landed.includes(CONTINUED), landed.slice(-300))
    check(`${tag}: the recovered cut paints the one calm line`, landed.includes(CALM_LINE), linesWith(landed, 'stream').join(' | ') || '(no line names the stream)')
    check(`${tag}: no API Error card in the default view`, !landed.includes('API Error'), linesWith(landed, 'API Error').join(' | '))
    check(`${tag}: no warning triangle names the cut`, !landed.split('\n').some(line => line.includes('▲') && /stream|continu/i.test(line)), linesWith(landed, '▲').join(' | '))
    check(`${tag}: the reconstructed-continuation note stays out of the chat`, !landed.includes('reconstructed continuation'), linesWith(landed, 'reconstructed').join(' | '))
    const grid = shot.grids.landed
    const cells = grid ? rowCells(grid, CALM_LINE) : null
    if (cells) {
      const countCell = cells[CALM_LINE.indexOf('1')]
      const wordCell = cells[0]
      check(`${tag}: the count is bold and the words are not`, countCell?.bold === true && wordCell?.bold !== true, `count ${JSON.stringify(countCell)} word ${JSON.stringify(wordCell)}`)
      check(`${tag}: the line wears one colour, no red`, cells.every(c => c.fg === wordCell?.fg), Array.from(new Set(cells.map(c => c.fg))).join(','))
    }
    const expanded = shot.marks.expanded ?? ''
    const debugDir = join(home, 'debug')
    const debugLines = existsSync(debugDir)
      ? readdirSync(debugDir).flatMap(name => readFileSync(join(debugDir, name), 'utf8').split('\n'))
      : []
    const forensicsLine = debugLines.find(line => line.includes('[openai] stream fault forensics'))
    const noteLine = debugLines.find(line => line.includes('[openai] reconstructed continuation'))
    check(`${tag}: the cut left its forensics in the debug log`, forensicsLine !== undefined && /code=read-failed/.test(forensicsLine) && /sent=terminated/.test(forensicsLine) && /phase=mid-text/.test(forensicsLine) && /cf-ray=fixture-ray-0001-LHR/.test(forensicsLine) && /since-last-byte=\d+ms/.test(forensicsLine), forensicsLine === undefined ? `no forensics line among ${debugLines.length} debug lines under ${debugDir}` : forensicsLine.slice(0, 300))
    check(`${tag}: the reconstructed-continuation note went to the debug log`, noteLine !== undefined, `no note among ${debugLines.length} debug lines`)
    check(`${tag}: the expansion carries the road, what the provider sent and the code`, expanded.includes('ChatGPT pro subscription') && expanded.includes('read-failed') && expanded.includes('terminated'), linesWith(expanded, 'stream').join(' | '))
  }
} finally {
  server.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log(`\n${failures === 0 ? 'prove-stream-cut-drive: ALL LAWS HOLD' : `prove-stream-cut-drive: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

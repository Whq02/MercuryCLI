#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dir
const REPO = resolve(HERE, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const OLD = argAfter('--old')
const FRAMES = argAfter('--frames')
const KEEP = process.argv.includes('--keep')
const MODEL = 'gpt-5.6-sol'
const BUN = process.env.BUN ?? process.execPath
const PROBE_KEY = 'proof-key-ci-gate-not-a-real-key'
const SIZES: Array<[number, number]> = [
  [80, 21],
  [80, 14],
  [82, 17],
  [120, 40],
]
const j = (v: unknown): string => JSON.stringify(v)
const nodeFor = (dist: string): string => {
  const vendored = join(dist, '..', 'vendor', 'node', 'bin', 'node')
  return existsSync(vendored) ? vendored : 'node'
}

type Turn = { text: string } | { error: { status: number; body: unknown } }
const MODELS_BODY = {
  models: [
    {
      slug: MODEL,
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}
const sse = (obj: unknown): string => `data: ${j(obj)}\n\n`
function responsesSse(text: string, ordinal: number): string {
  return [
    sse({ type: 'response.created', response: { id: `resp_${ordinal}` } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: `resp_${ordinal}`, usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function pngDims(dataUrl: string): { width: number; height: number } | null {
  const data = dataUrl.replace(/^data:[^,]*,/, '')
  const header = Buffer.from(data.slice(0, 64), 'base64')
  if (header.length < 24 || header[0] !== 0x89 || header[1] !== 0x50) return null
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}
function imagesOf(body: Record<string, unknown>): Array<{ width: number; height: number }> {
  const out: Array<{ width: number; height: number }> = []
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  for (const item of input) {
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined
    if (!Array.isArray(parts)) continue
    for (const part of parts as Array<{ type?: string; image_url?: string }>) {
      if (part.type === 'input_image' && typeof part.image_url === 'string') out.push(pngDims(part.image_url) ?? { width: 0, height: 0 })
    }
  }
  return out
}

async function serve(captureFile: string, scriptFile: string): Promise<void> {
  let seq = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.startsWith('/openai/') ? j(MODELS_BODY) : j({ data: [], has_more: false }))
        return
      }
      if (!(req.method === 'POST' && url.endsWith('/responses'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      seq++
      let script: Turn[] = []
      try {
        script = JSON.parse(readFileSync(scriptFile, 'utf8')) as Turn[]
      } catch {
        script = []
      }
      const turn = script[seq - 1] ?? { text: 'script exhausted' }
      appendFileSync(captureFile, `${j({ seq, images: imagesOf(body), turn: 'error' in turn ? 'error' : 'text' })}\n`)
      if ('error' in turn) {
        res.writeHead(turn.error.status, { 'content-type': 'application/json' })
        res.end(j(turn.error.body))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse(turn.text, seq))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    console.log(`PORT ${typeof address === 'object' && address ? address.port : 0}`)
  })
}

if (process.argv[2] === '--serve') {
  const captureFile = process.argv[3]
  const scriptFile = process.argv[4]
  if (!captureFile || !scriptFile) {
    console.error('usage: prove-image-refusal-frames.ts --serve <captureFile> <scriptFile>')
    process.exit(2)
  }
  await serve(captureFile, scriptFile)
} else {
  let failures = 0
  let checks = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    checks++
    if (!ok) failures++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
  }
  const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
  const { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
  const driver = resolveCaptureDriver()
  if (driver.kind === 'unavailable') {
    console.log(`FAIL no capture driver: ${driver.reason} — ${driver.remedy}`)
    process.exit(1)
  }
  if (!existsSync(DIST)) {
    console.log(`❌ no bundle at ${DIST}`)
    process.exit(1)
  }
  const SCRATCH = join(realpathSync(tmpdir()), `image-refusal-frames-${randomUUID().slice(0, 8)}`)
  const SEED_HOME = join(SCRATCH, 'seed-home')
  const CWD = join(SCRATCH, 'project')
  mkdirSync(SEED_HOME, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  if (FRAMES) mkdirSync(FRAMES, { recursive: true })
  writeFileSync(
    join(SEED_HOME, '.mercury.json'),
    j({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(SEED_HOME, 'settings.json'), '{}')
  writeFileSync(join(CWD, 'README.md'), '# fixture\n')
  const sharp = (await import('sharp')).default
  const BIG = join(CWD, 'big.png')
  writeFileSync(BIG, await sharp({ create: { width: 6000, height: 6000, channels: 3, background: { r: 244, g: 244, b: 240 } } }).png({ compressionLevel: 9 }).toBuffer())

  type Fixture = { port: number; capture: () => Array<{ seq: number; images: Array<{ width: number; height: number }>; turn: string }>; kill: () => void }
  async function startFixture(name: string, turns: Turn[]): Promise<Fixture> {
    const captureFile = join(SCRATCH, `${name}-capture.jsonl`)
    const scriptFile = join(SCRATCH, `${name}-script.json`)
    writeFileSync(captureFile, '')
    writeFileSync(scriptFile, j(turns))
    const child = spawn(BUN, ['run', import.meta.path, '--serve', captureFile, scriptFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise<number>((resolvePort, reject) => {
      const killer = setTimeout(() => reject(new Error('fixture never printed its port')), 20_000)
      child.stdout!.on('data', (chunk: Buffer) => {
        const m = /PORT (\d+)/.exec(chunk.toString('utf8'))
        if (m) {
          clearTimeout(killer)
          resolvePort(Number(m[1]))
        }
      })
      child.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
    })
    return {
      port,
      capture: () =>
        readFileSync(captureFile, 'utf8')
          .split('\n')
          .filter(l => l.trim() !== '')
          .map(l => JSON.parse(l) as { seq: number; images: Array<{ width: number; height: number }>; turn: string }),
      kill: () => {
        try {
          child.kill('SIGTERM')
        } catch {
        }
      },
    }
  }
  function childEnv(home: string, port: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_TABULA_DIR: join(home, 'tabula'),
      MERCURY_TABULA_MINERVA: '0',
      MERCURY_HOME: join(home, 'proof-home'),
      MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
      ANTHROPIC_API_KEY: PROBE_KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${port}/openai/v1`,
      MERCURY_OPENAI_CHATGPT_BASE: `http://127.0.0.1:${port}/openai/chatgpt`,
      MERCURY_OPENAI_AUTH_BASE: `http://127.0.0.1:${port}/openai/auth`,
      OPENAI_API_KEY: 'fixture-openai-key',
      MERCURY_STREAM_IDLE_TIMEOUT_MS: '30000',
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
      MERCURY_OPERATOR: 'sam',
      BROWSER: '/usr/bin/true',
    }
    delete env.NODE_ENV
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.MERCURY_MODEL
    return env
  }

  const REFUSAL: Turn = {
    error: {
      status: 400,
      body: {
        error: {
          message: 'Invalid image: the image exceeds the maximum number of patches (30000) allowed for this model.',
          type: 'invalid_request_error',
          param: 'input',
          code: 'invalid_image',
        },
      },
    },
  }

  section('seed · a session whose record holds the image a first turn attached at 6000x6000')
  const SEED_DIST = OLD ?? DIST
  const sessionId = randomUUID()
  {
    const fixture = await startFixture('seed', [{ text: 'I see a flat image.' }])
    const result = spawnSync(nodeFor(SEED_DIST), [SEED_DIST, '-p', '--output-format', 'json', '--model', MODEL, '--permission-mode', 'bypassPermissions', '--session-id', sessionId, `describe @${BIG}`], {
      cwd: CWD,
      env: childEnv(SEED_HOME, fixture.port),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 256 * 1024 * 1024,
    })
    const seen = fixture.capture()[0]
    check('the seeding run settled', result.status === 0, `exit ${result.status}; stderr: ${(result.stderr ?? '').slice(-300)}`)
    check('its record carries the image the wire saw', seen !== undefined && seen.images.length === 1, j(seen))
    console.log(`  [record] the seeding bundle sent ${seen ? `${seen.images[0]?.width}x${seen.images[0]?.height}` : 'no image'} (${SEED_DIST})`)
    fixture.kill()
  }

  type Send = { atTick: number; minTick?: number; afterPrevTicks?: number; awaitText?: string; awaitSettleTicks?: number; data: string; mark?: string }
  type Grid = Array<Array<{ c: string }>>
  type Payload = { grid: Grid; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
  const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

  async function captureRefusal(label: string, dist: string, cols: number, rows: number, needle: string): Promise<{ text: string; hit: boolean; sent: number; images: Array<{ width: number; height: number }> }> {
    const home = join(SCRATCH, `home-${label}-${cols}x${rows}`)
    cpSync(SEED_HOME, home, { recursive: true })
    const fixture = await startFixture(`${label}-${cols}x${rows}`, [REFUSAL, REFUSAL, REFUSAL])
    const out = join(SCRATCH, `capture-${label}-${cols}x${rows}.json`)
    const sends: Send[] = [
      { atTick: 120, minTick: 3, awaitText: 'Yes, I accept', awaitSettleTicks: 2, data: '\x1b[B\r' },
      { atTick: 250, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
      { atTick: 420, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: 'again\r' },
      { atTick: 620, minTick: 10, awaitText: needle, awaitSettleTicks: 6, data: '', mark: 'row' },
    ]
    const cfg = { argv: [nodeFor(dist), dist, '--model', MODEL, '--resume', sessionId], cwd: CWD, sends, readyText: ['Type a prompt', 'choose', 'accept'], stableTicks: 4, total: 700, cols, rows, out }
    const cfgPath = join(SCRATCH, `cfg-${label}-${cols}x${rows}.json`)
    writeFileSync(cfgPath, j(cfg))
    const res = spawnSync(driver.python, [captureEngineEntry(driver, REPO), cfgPath], {
      cwd: REPO,
      env: childEnv(home, fixture.port),
      encoding: 'utf8',
      timeout: vshotBudgetMs(700 * 200 + 40_000),
      maxBuffer: 64 * 1024 * 1024,
    })
    fixture.kill()
    const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
    const mark = payload?.marks?.find(m => m.label === 'row')
    const text = payload ? gridText(mark?.grid ?? payload.grid) : `no capture (exit ${res.status}): ${(res.stderr ?? '').slice(-400)}`
    if (FRAMES) writeFileSync(join(FRAMES, `${label}-refusal-${cols}x${rows}.txt`), `${text}\n`)
    const captured = fixture.capture()
    return { text, hit: text.includes(needle), sent: captured.length, images: captured.flatMap(c => c.images) }
  }
  const patches = (w: number, h: number): number => Math.ceil(w / 32) * Math.ceil(h / 32)

  const NEW_NEEDLE = 'openai-invalid_image'
  const OLD_NEEDLE = 'stream failed'
  section(`new · the image rides within the family's patch rule and the provider's refusal paints as the route's error row on ${DIST}`)
  for (const [cols, rows] of SIZES) {
    const shot = await captureRefusal('new', DIST, cols, rows, NEW_NEEDLE)
    check(`${cols}x${rows}: the image reached the wire once, within the family's patch rule, and the provider's refusal painted as the route's error row`, shot.hit && shot.sent === 1 && shot.images.length === 1 && shot.images.every(i => patches(i.width, i.height) <= 30_000), `wire requests: ${shot.sent}; images: ${j(shot.images)}; screen tail: ${shot.text.split('\n').slice(-8).join(' | ').slice(0, 500)}`)
  }
  if (OLD) {
    section(`old · the provider's refusal on ${OLD}`)
    for (const [cols, rows] of SIZES) {
      const shot = await captureRefusal('old', OLD, cols, rows, OLD_NEEDLE)
      check(`${cols}x${rows}: the old bundle sent the image and shows the provider's refusal`, shot.hit && shot.sent >= 1, `wire requests: ${shot.sent}; screen tail: ${shot.text.split('\n').slice(-8).join(' | ').slice(0, 500)}`)
    }
  }

  if (!KEEP && failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`kept: ${SCRATCH}`)
  console.log(`\nprove-image-refusal-frames: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

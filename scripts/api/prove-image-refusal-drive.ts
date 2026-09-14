#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const KEEP = process.argv.includes('--keep')
const MODEL = 'gpt-5.6-sol'
const BUN = process.env.BUN ?? process.execPath
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const PROBE_KEY = 'proof-key-ci-gate-not-a-real-key'
const j = (v: unknown): string => JSON.stringify(v)

type Turn = { text: string } | { error: { status: number; body: unknown } }
type Capture = { seq: number; images: Array<{ width: number; height: number; base64Chars: number }>; texts: string[]; assistantTexts: string[]; itemTypes: string[]; turn: 'text' | 'error' }

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

function summarize(seq: number, body: Record<string, unknown>, turn: Capture['turn']): Capture {
  const out: Capture = { seq, images: [], texts: [], assistantTexts: [], itemTypes: [], turn }
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  for (const item of input) {
    out.itemTypes.push(String(item.type))
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined
    if (typeof parts === 'string') {
      if (item.role === 'assistant') out.assistantTexts.push(parts.slice(0, 120))
      else out.texts.push(parts.slice(0, 120))
      continue
    }
    if (!Array.isArray(parts)) continue
    for (const part of parts as Array<{ type?: string; text?: string; image_url?: string }>) {
      if (part.type === 'input_image' && typeof part.image_url === 'string') {
        const dims = pngDims(part.image_url) ?? { width: 0, height: 0 }
        out.images.push({ ...dims, base64Chars: part.image_url.replace(/^data:[^,]*,/, '').length })
      } else if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        if (item.role === 'assistant') out.assistantTexts.push(part.text.slice(0, 120))
        else out.texts.push(part.text.slice(0, 120))
      }
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
      appendFileSync(captureFile, `${j(summarize(seq, body, 'error' in turn ? 'error' : 'text'))}\n`)
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
    console.error('usage: prove-image-refusal-drive.ts --serve <captureFile> <scriptFile>')
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
  if (!existsSync(DIST)) {
    console.log(`❌ no bundle at ${DIST}`)
    process.exit(1)
  }
  console.log(`bundle: ${DIST}\nnode: ${NODE}`)

  const SCRATCH = join(realpathSync(tmpdir()), `image-refusal-drive-${randomUUID().slice(0, 8)}`)
  const HOME = join(SCRATCH, 'home')
  const CWD = join(SCRATCH, 'project')
  mkdirSync(HOME, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  writeFileSync(
    join(HOME, '.mercury.json'),
    j({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(HOME, 'settings.json'), '{}')
  writeFileSync(join(CWD, 'README.md'), '# fixture\n')
  const sharp = (await import('sharp')).default
  const flat = (width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 244, g: 244, b: 240 } } }).png({ compressionLevel: 9 }).toBuffer()
  const BIG = join(CWD, 'big.png')
  const SMALL = join(CWD, 'small.png')
  writeFileSync(BIG, await flat(6000, 6000))
  writeFileSync(SMALL, await flat(64, 48))
  const patches = (w: number, h: number): number => Math.ceil(w / 32) * Math.ceil(h / 32)

  type Fixture = { port: number; capture: () => Capture[]; kill: () => void }
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
          .map(l => JSON.parse(l) as Capture),
      kill: () => {
        try {
          child.kill('SIGTERM')
        } catch {
        }
      },
    }
  }

  function childEnv(port: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: HOME,
      MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
      MERCURY_TEAMS_DIR: join(HOME, 'teams'),
      MERCURY_TABULA_DIR: join(HOME, 'tabula'),
      MERCURY_TABULA_MINERVA: '0',
      MERCURY_HOME: join(HOME, 'proof-home'),
      MERCURY_DOCTOR_STATE_DIR: join(HOME, 'doctor-state'),
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

  type Run = { status: number | null; frames: Array<Record<string, unknown>>; stderr: string; stdout: string }
  function runProduct(port: number, args: { prompt: string; sessionId?: string; resume?: string }): Run {
    const argv = [
      DIST,
      '-p',
      '--output-format',
      'stream-json',
      '--model',
      MODEL,
      '--permission-mode',
      'bypassPermissions',
      ...(args.sessionId ? ['--session-id', args.sessionId] : []),
      ...(args.resume ? ['--resume', args.resume] : []),
      args.prompt,
    ]
    const result = spawnSync(NODE, argv, { cwd: CWD, env: childEnv(port), encoding: 'utf8', timeout: 180_000, maxBuffer: 256 * 1024 * 1024 })
    const frames: Array<Record<string, unknown>> = []
    for (const line of (result.stdout ?? '').split('\n')) {
      if (line.trim() === '') continue
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
      }
    }
    return { status: result.status, frames, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
  }
  const assistantTexts = (run: Run): string[] => {
    const out: string[] = []
    for (const frame of run.frames) {
      if (frame.type !== 'assistant') continue
      const content = (frame.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
      if (!Array.isArray(content)) continue
      for (const block of content) if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
    return out
  }
  const resultFrame = (run: Run): Record<string, unknown> | undefined => run.frames.find(f => f.type === 'result')
  const recordFiles = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).isDirectory()) out.push(...recordFiles(p))
        else if (name.endsWith('.jsonl')) out.push(p)
      } catch {
      }
    }
    return out
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

  section('A · the pre-send rule on the built product: a 6000x6000 file attachment on a GPT session')
  {
    const fixture = await startFixture('a', [{ text: 'I see a flat image.' }])
    const run = runProduct(fixture.port, { prompt: `describe @${BIG}` })
    const captured = fixture.capture()
    const first = captured[0]
    check('the run settled with a result', run.status === 0 && resultFrame(run) !== undefined, `exit ${run.status}; stderr: ${run.stderr.slice(-400)}`)
    check('one request reached the Responses wire carrying one image', captured.length >= 1 && first?.images.length === 1, j(captured.map(c => ({ seq: c.seq, images: c.images, texts: c.texts }))).slice(0, 400))
    const image = first?.images[0]
    check(
      'the image the wire saw fits the provider\'s 30,000-patch rule (the ingestion shrank it)',
      image !== undefined && patches(image.width, image.height) <= 30_000,
      image ? `the wire saw ${image.width}x${image.height} = ${patches(image.width, image.height).toLocaleString('en-US')} patches` : 'no image',
    )
    check('…and kept its detail near the rule (above 29,000 patches)', image !== undefined && patches(image.width, image.height) > 29_000, image ? `${image.width}x${image.height}` : 'no image')
    fixture.kill()
  }

  section('B · the refused image leaves every later request on the built product, a resume included')
  {
    const fixture = await startFixture('b', [REFUSAL, { text: 'the answer after the refusal' }, { text: 'the answer after the resume' }])
    const sessionId = randomUUID()
    const first = runProduct(fixture.port, { prompt: `describe @${SMALL}`, sessionId })
    const captured1 = fixture.capture()
    check('the first request carried the attached image', captured1[0]?.images.length === 1 && captured1[0].images[0]?.width === 64, j(captured1).slice(0, 300))
    const rows = assistantTexts(first)
    const refusalRow = rows.find(t => t.startsWith('API Error: OpenAI stream failed (openai-invalid_image)'))
    check('the provider\'s refusal settled as the route\'s error row, its words unchanged', refusalRow !== undefined && refusalRow.includes('Invalid image'), j(rows).slice(0, 400) || `exit ${first.status}; stderr: ${first.stderr.slice(-300)}`)
    const records = recordFiles(join(HOME, 'projects')).filter(p => p.endsWith(`${sessionId}.jsonl`))
    const record = records[0] ? readFileSync(records[0], 'utf8') : ''
    check('the session record holds the refusal row', record.includes('openai-invalid_image'), records.length === 0 ? `no record for ${sessionId} under ${join(HOME, 'projects')}` : '')
    check('…stamped with the typed media refusal', record.includes('"mediaRefusal"'))

    const second = runProduct(fixture.port, { prompt: 'and now?', resume: sessionId })
    const captured2 = fixture.capture()
    const request2 = captured2[1]
    check('the resumed session\'s request reached the wire', request2 !== undefined && second.status === 0, `exit ${second.status}; ${captured2.length} request(s); stderr: ${second.stderr.slice(-300)}`)
    check('the resumed request carries no image', request2 !== undefined && request2.images.length === 0, request2 ? `the wire saw ${j(request2.images)}` : 'no request')
    check('…while the attachment\'s text still rides', request2 !== undefined && request2.texts.some(t => /small\.png|Result of|describe/.test(t)), j(request2?.texts).slice(0, 300))
    check('the resumed run answered', assistantTexts(second).some(t => t.includes('the answer after the refusal')), j(assistantTexts(second)).slice(0, 300))
    fixture.kill()
  }

  if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`kept: ${SCRATCH}`)
  console.log(`\nprove-image-refusal-drive: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

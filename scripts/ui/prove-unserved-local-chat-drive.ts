#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { FAKE_BIN, FAKE_SCRIPT, QWEN_2B_REPO, fakeWorld } from '../tensorfold/fixtures/world.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const FRAMES = argAfter('--frames')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const DEAD = 'http://127.0.0.1:1'
const KEY = 'proof-key-ci-gate-not-a-real-key'
const MODEL = 'local/qwen3.5-2b'
const NAME = 'qwen3.5-2b'
const NOTICE = `▲ ${MODEL} is not being served — /tensorfold serves it again · /model chooses another`
const NOTICE_PLAIN = `▲ ${MODEL} is not being served — start a local server, or set MERCURY_LOCAL_BASE_URL · /model chooses another`
const NOTICE_HEAD = 'is not being served'
const UNLISTED = 'no local server lists this model'
const RAIN = 'Say five words about rain.'
const SNOW = 'Say five words about snow.'
const ANSWERED = `fake TensorFold says: ${SNOW}`
const HOSTED = 'claude-opus-4-8'
const HOSTED_ANSWER = 'A scripted answer from the other model.'
const BACK = '\u001b[1;2D'
const DOWN = '\u001b[B'
const HOSTED_NAME = 'Opus 4.8'
const STOPPED = `TensorFold stopped ${NAME}`
const SAID = 'fake TensorFold says:'
const SERVE_KEY = '↵ serve and switch'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

if (!existsSync(BIN)) {
  console.error(`  ${BIN} missing — bun run build.ts first (or pass --dist <bundle>)`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(1)
}
const PYTHON = driver.python
const VENDORED_NODE = join(dirname(BIN), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')
const freePort = (): Promise<number> =>
  new Promise((settle, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => settle(port))
    })
  })

type Grid = Array<Array<{ c: string }>>
type Send = Record<string, unknown>
interface Capture {
  marks: Record<string, string>
  final: string
  endReason: string
  delivered: number
  asked: number
  note: string
}
interface World {
  root: string
  home: string
  cwd: string
  port: number
  log: string
  env: NodeJS.ProcessEnv
  engine: ReturnType<typeof fakeWorld>
}
const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, '')).join('\n')
const flat = (frame: string | undefined): string => (frame ?? '').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')
const count = (frame: string | undefined, needle: string): number => flat(frame).split(needle).length - 1
const worlds: World[] = []

async function makeWorld(opts: { saved?: string | null; servedBefore?: boolean; key?: string; provider?: string } = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'unserved-chat-')))
  const home = join(root, 'home')
  const userHome = join(root, 'user')
  const cwd = join(root, 'repo')
  for (const dir of [home, userHome, cwd, join(root, 'tmp'), join(home, 'local-setup'), join(home, 'tensorfold')]) mkdirSync(dir, { recursive: true })
  if (opts.key !== undefined) process.env.ANTHROPIC_API_KEY = opts.key
  seedFirstRun(home, [cwd])
  const saved = opts.saved === undefined ? MODEL : opts.saved
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } }, ...(saved === null ? {} : { engine: { model: saved } }) }))
  writeFileSync(join(cwd, 'README.md'), 'a fixture folder for the unserved-chat drive\n')
  const port = await freePort()
  writeFileSync(join(home, 'tensorfold', 'served.json'), `${JSON.stringify({ repo: QWEN_2B_REPO, name: NAME, port, window: 32768, project: cwd })}\n`)
  if (opts.servedBefore !== false) writeFileSync(join(home, 'local-setup', 'tensorfold-hosts.json'), JSON.stringify({ version: 1, hosts: [], ports: [port], windows: { [QWEN_2B_REPO.toLowerCase()]: 32768 } }))
  const engine = fakeWorld('unserved-chat-engine', {})
  const log = join(root, 'engine-requests.log')
  const env: NodeJS.ProcessEnv = {
    PATH: `${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: userHome,
    TMPDIR: join(root, 'tmp'),
    TERM: process.env.TERM ?? 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    HF_HUB_CACHE: engine.cache,
    FAKE_TENSORFOLD_BUN: process.execPath,
    FAKE_TENSORFOLD_SCRIPT: FAKE_SCRIPT,
    FAKE_TENSORFOLD_CACHE: engine.cache,
    FAKE_TENSORFOLD_LOG: log,
    ...(opts.key !== undefined ? { ANTHROPIC_API_KEY: opts.key } : {}),
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=http://127.0.0.1:${port}`,
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    BROWSER: 'true',
    ANTHROPIC_BASE_URL: opts.provider ?? DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_ANTHROPIC_OAUTH_BASE: DEAD,
    VSHOT_SLOTS: '999',
  }
  for (const key of ['MERCURY_VSHOT_BUDGET_SCALE', 'MERCURY_VSHOT_EMULATOR', 'PYTHONPATH']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const world = { root, home, cwd, port, log, env, engine }
  worlds.push(world)
  return world
}

let captures = 0
async function capture(world: World, label: string, size: string, sends: Send[], lastScene: string, opts: { argv?: string[]; total?: number; settle?: number } = {}): Promise<Capture> {
  const [cols, rows] = size.split('x').map(Number) as [number, number]
  const n = ++captures
  const out = join(world.root, `capture-${n}.json`)
  const cfgPath = join(world.root, `capture-${n}.cfg.json`)
  const total = opts.total ?? 300
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN, ...(opts.argv ?? [])], cwd: world.cwd, cols, rows, total, sends, readyText: lastScene, readySettleTicks: opts.settle ?? 5, out }))
  const child = spawn(PYTHON, [VSHOT, cfgPath], { env: world.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout!.on('data', () => {})
  child.stderr!.on('data', chunk => {
    stderr += String(chunk)
  })
  await new Promise<number | null>(settle => {
    const budget = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 90_000))
    child.on('exit', code => {
      clearTimeout(budget)
      settle(code)
    })
  })
  const note = stderr.split('\n').filter(line => /UNDELIVERED|NEVER-READY|refus/i.test(line)).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!existsSync(out)) return { marks: {}, final: '', endReason: 'no capture', delivered: 0, asked: sends.length, note: note || stderr.trim().split('\n').slice(-3).join(' | ') }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; endReason: string; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
  const marks: Record<string, string> = {}
  for (const mark of payload.marks ?? []) marks[mark.label] = textOf(mark.grid)
  const final = textOf(payload.grid)
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    const scrub = (frame: string): string => frame.split(world.root).join('<scratch>') + '\n'
    for (const [name, frame] of Object.entries(marks)) writeFileSync(join(FRAMES, `${label}-${name}-${size}.txt`), scrub(frame))
    writeFileSync(join(FRAMES, `${label}-final-${size}.txt`), scrub(final))
  }
  const delivered = (payload.sendReceipts ?? []).length
  console.log(`  ${label} ${size}: ${delivered} of ${sends.length} keys delivered, the watch ended by ${payload.endReason}${note === '' ? '' : ` — ${note}`}`)
  return { marks, final, endReason: payload.endReason, delivered, asked: sends.length, note }
}
function stopDaemon(world: World): void {
  spawnSync(NODE, [BIN, 'daemon', 'stop'], { env: world.env, cwd: world.cwd, timeout: 20_000 })
}
const at = (needle: string, data: string, mark?: string, settle = 3): Send => ({ requireAwait: true, awaitText: needle, awaitSettleTicks: settle, ...(mark !== undefined ? { mark } : {}), data })
const typed = (after: string, words: string): Send[] => [at(after, words, undefined, 4), at(words, '\r', undefined, 2)]
const requestsOf = (world: World): string[] => (existsSync(world.log) ? readFileSync(world.log, 'utf8').split('\n').filter(line => line.startsWith('request ')).map(line => line.slice('request '.length)) : [])
const transcriptsOf = (world: World): string[] => {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.jsonl')) found.push(path)
    }
  }
  walk(join(world.home, 'projects'))
  return found
}

try {
  section('S1 a new chat on a saved local model that nothing serves, 150x40')
  const first = await makeWorld()
  const born = await capture(
    first,
    'new',
    '150x40',
    [
      at('↑↓ choose', '\r', 'home', 2),
      at(NOTICE_HEAD, RAIN, 'opened', 6),
      at(RAIN, '\r', undefined, 2),
      at(UNLISTED, '/tensorfold', 'meanwhile', 4),
      at('/tensorfold', '\r', undefined, 2),
      at(SERVE_KEY, '\r', 'panel', 4),
      at(`serving ${NAME} on 127.0.0.1:${first.port}`, '\u001b', 'served', 4),
      at("this session's model", SNOW, 'back', 4),
      at(SNOW, '\r', undefined, 2),
      at(ANSWERED, '/tensorfold', 'answered', 4),
      at('/tensorfold', '\r', undefined, 2),
      at('s stops', 's', undefined, 4),
      at('s again stops it', 's', undefined, 2),
      at(`stopped ${NAME}`, '\u001b', 'stopped', 4),
      ...typed(STOPPED, '/exit'),
    ],
    'Session saved',
    { total: 420 },
  )
  check('every key of the journey was sent on the product’s own words', born.delivered === born.asked, `${born.delivered} of ${born.asked} ${born.note}`)
  check('[U-85] New Session opens the chat and it stays: the card names the model, the status row reads ready', flat(born.marks.opened).includes(`model ${MODEL} the model this session runs on`) && flat(born.marks.opened).includes(`ready · ${MODEL}`) && !flat(born.marks.opened).includes('the chat could not start'), flat(born.marks.opened).slice(0, 600))
  check('the chat carries the notice, whole on one line, once', (born.marks.opened ?? '').includes(NOTICE) && count(born.marks.opened, NOTICE_HEAD) === 1, (born.marks.opened ?? '').split('\n').filter(line => line.includes('▲')).join(' | '))
  check('a prompt sent meanwhile is answered by the local road’s own sentence and the chat stays', flat(born.marks.meanwhile).includes(`API Error: ${UNLISTED}`) && flat(born.marks.meanwhile).includes(`Model '${MODEL}' cannot run.`) && flat(born.marks.meanwhile).includes('Type a prompt'), flat(born.marks.meanwhile).slice(0, 700))
  check('/tensorfold opens in that chat with the model on disk and its serve key', flat(born.marks.panel).includes('Mercury · tensorfold') && /Qwen3\.5 2B\s+local\/qwen3\.5-2b\s+on disk/.test(flat(born.marks.panel)) && flat(born.marks.panel).includes(SERVE_KEY) && !flat(born.marks.panel).includes('↵ install') && !flat(born.marks.panel).includes('↵ pull'), flat(born.marks.panel).slice(0, 700))
  check('the serve comes up and the session takes it', flat(born.marks.served).includes(`serving ${NAME} on 127.0.0.1:${first.port}`) && flat(born.marks.back).includes(`TensorFold serves ${NAME}`) && flat(born.marks.back).includes("this session's model"), `${flat(born.marks.served).slice(0, 300)} || ${flat(born.marks.back).slice(-400)}`)
  check('the next prompt is answered by the engine', flat(born.marks.answered).includes(ANSWERED), flat(born.marks.answered).slice(-500))
  check('the notice is still one row of that chat, where it was said', count(born.marks.answered, NOTICE_HEAD) === 1, String(count(born.marks.answered, NOTICE_HEAD)))
  const firstRequests = requestsOf(first)
  check('nothing the engine was sent carries the notice', firstRequests.some(body => body.includes(SNOW)) && !firstRequests.some(body => body.includes(NOTICE_HEAD)), `${firstRequests.length} requests, ${firstRequests.filter(body => body.includes(SNOW)).length} with the prompt`)

  section('S2 Continue Last Session on that chat, the engine stopped again, 150x40 and 80x40')
  for (const size of ['150x40', '80x40']) {
    const resumed = await capture(first, 'continue', size, [at('Continue Last Session', DOWN, 'home', 3), at('Continue Last Session', '\r', undefined, 3), at(NOTICE_HEAD, '', 'resumed', 8), ...typed(NOTICE_HEAD, '/exit')], 'Session saved', { total: 220 })
    const frame = resumed.marks.resumed
    check(`[U-85] ${size}: Continue Last Session opens the chat with its rows and the notice, wrapped and whole, once`, resumed.delivered === resumed.asked && flat(frame).includes(NOTICE.replace('▲ ', '')) && count(frame, NOTICE_HEAD) === 1 && flat(frame).includes(SAID) && !flat(frame).includes('the chat could not start'), `${resumed.delivered}/${resumed.asked} ${flat(frame).slice(-600)}`)
    check(`${size}: the home screen it came from carried no line of it`, !flat(resumed.marks.home).includes(NOTICE_HEAD), flat(resumed.marks.home).slice(-300))
  }
  const written = transcriptsOf(first).map(path => readFileSync(path, 'utf8'))
  check('the session’s record on disk gains no line of the notice: a later resume replays none as anyone’s words', written.length > 0 && !written.some(text => text.includes(NOTICE_HEAD)), `${written.length} transcript files`)
  stopDaemon(first)

  section('S3 the notice at 80 columns, on a model Mercury’s engine never served here, and the home screen after the chat is entered')
  const narrow = await makeWorld({ servedBefore: false })
  const small = await capture(narrow, 'new-narrow', '80x40', [at('↑↓ choose', '\r', 'home', 2), at(NOTICE_HEAD, BACK, 'opened', 6), at('enters it', BACK, 'board', 4), at('↑↓ choose', '', 'home-again', 4)], '↑↓ choose', { total: 180 })
  check('at 80 columns the notice is wrapped, not cut, and names the local server where the engine never served the model', small.delivered === small.asked && flat(small.marks.opened).includes(NOTICE_PLAIN.replace('▲ ', '')) && count(small.marks.opened, NOTICE_HEAD) === 1 && !(small.marks.opened ?? '').split('\n').some(line => line.includes(NOTICE_HEAD) && line.includes('…')), (small.marks.opened ?? '').split('\n').filter(line => /served|server|chooses/.test(line)).join(' | '))
  check('back on the home screen nothing of the notice is painted', flat(small.marks['home-again']).includes('↑↓ choose') && !flat(small.marks['home-again']).includes(NOTICE_HEAD), flat(small.marks['home-again']).slice(-300))
  stopDaemon(narrow)

  section('S4 /model chooses another model in that chat')
  const provider = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: HOSTED_ANSWER })))
  try {
    const keyed = await makeWorld({ key: KEY, provider: provider.url })
    const switched = await capture(
      keyed,
      'model',
      '150x40',
      [at('↑↓ choose', '\r', 'home', 2), at(NOTICE_HEAD, `/model ${HOSTED}`, 'opened', 6), at(`/model ${HOSTED}`, '\r', undefined, 2), at(`ready · ${HOSTED_NAME}`, RAIN, 'switched', 6), at(RAIN, '\r', undefined, 2), at(HOSTED_ANSWER, '', 'answered', 4)],
      HOSTED_ANSWER,
      { total: 260 },
    )
    check('the status row names the model chosen and its prompt is answered there', switched.delivered === switched.asked && flat(switched.marks.switched).includes(`ready · ${HOSTED_NAME}`) && flat(switched.marks.switched).includes(`Model now: ${HOSTED_NAME}`) && count(switched.marks.switched, NOTICE_HEAD) === 1 && flat(switched.marks.answered).includes(HOSTED_ANSWER), `${switched.delivered}/${switched.asked} ${flat(switched.marks.answered).slice(-400)}`)
    const sent = provider.messageRequests().map(request => JSON.stringify(request.body))
    check('the other model’s request carries nothing of the notice', sent.length >= 1 && !sent.some(body => body.includes(NOTICE_HEAD)), `${sent.length} requests`)
    stopDaemon(keyed)
  } finally {
    await provider.close()
  }

  section('S5 the first prompt of a chat born with the notice and of one born while the engine serves: the same request')
  const noted = await makeWorld()
  const afterServe = await capture(
    noted,
    'noted',
    '150x40',
    [at('↑↓ choose', '\r', 'home', 2), at(NOTICE_HEAD, '/tensorfold', 'opened', 6), at('/tensorfold', '\r', undefined, 2), at(SERVE_KEY, '\r', undefined, 4), at(`serving ${NAME} on 127.0.0.1:${noted.port}`, '\u001b', undefined, 4), at("this session's model", SNOW, undefined, 4), at(SNOW, '\r', undefined, 2), at(SAID, '/tensorfold', 'answered', 6), at('/tensorfold', '\r', undefined, 2), at('s stops', 's', undefined, 4), at('s again stops it', 's', undefined, 2), at(`stopped ${NAME}`, '\u001b', undefined, 4), ...typed(STOPPED, '/exit')],
    'Session saved',
    { total: 380 },
  )
  stopDaemon(noted)
  const serving = await makeWorld()
  const engineProcess = spawn(process.execPath, [FAKE_SCRIPT, 'serve', QWEN_2B_REPO, '--name', NAME, '--context', '32768', '--port', String(serving.port)], { env: { ...serving.env, HOME: serving.engine.home }, stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    const up = await new Promise<boolean>(settle => {
      let said = ''
      const watchdog = setTimeout(() => engineProcess.kill('SIGKILL'), vshotBudgetMs(30_000))
      engineProcess.stderr!.on('data', chunk => {
        said += String(chunk)
        if (!said.includes(`serving ${NAME} at`)) return
        clearTimeout(watchdog)
        settle(true)
      })
      engineProcess.once('exit', () => {
        clearTimeout(watchdog)
        settle(false)
      })
    })
    const plain = await capture(serving, 'serving', '150x40', [at('↑↓ choose', '\r', 'home', 2), at(`ready · ${MODEL}`, SNOW, 'opened', 8), at(SNOW, '\r', undefined, 2), at(SAID, '', 'answered', 6), ...typed(SAID, '/exit')], 'Session saved', { total: 220 })
    check('a chat born on a served model carries no notice and is answered (holds on the parent too)', up && plain.delivered === plain.asked && !flat(plain.marks.opened).includes(NOTICE_HEAD) && flat(plain.marks.answered).includes(SAID), `${plain.delivered}/${plain.asked} ${flat(plain.marks.answered).slice(-300)}`)
    const names = (world: World, body: string): string => body.split(world.root).join('<root>').split(world.engine.root).join('<engine>').split(basename(world.root)).join('<run>').replace(/-repo-[0-9a-f]{8}\b/g, '-repo-<hash>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<time>').replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, '<clock>')
    const listing = /## Skills\\n[\s\S]*?capsule-digest:[0-9a-f]+/
    const listed = (body: string): string[] => (listing.exec(body)?.[0] ?? '').split('\\n').filter(line => line.startsWith('- '))
    const noteRequest = names(noted, requestsOf(noted).find(body => body.includes(SNOW)) ?? 'none')
    const plainRequest = names(serving, requestsOf(serving).find(body => body.includes(SNOW)) ?? 'absent')
    const withNote = noteRequest.replace(listing, '## Skills')
    const without = plainRequest.replace(listing, '## Skills')
    const differs = [...withNote].findIndex((char, index) => char !== without[index])
    check('the chat born with the notice is served and answered', afterServe.delivered === afterServe.asked && flat(afterServe.marks.answered).includes(SAID) && count(afterServe.marks.answered, NOTICE_HEAD) === 1, `${afterServe.delivered}/${afterServe.asked}`)
    check('its request is byte for byte the request of the chat born without one, the run’s own names and the list of skills apart, and the notice is in neither', withNote === without && !noteRequest.includes(NOTICE_HEAD) && !plainRequest.includes(NOTICE_HEAD) && withNote.includes(SNOW), `${withNote.length} against ${without.length} characters; they part at ${differs}: ${withNote.slice(Math.max(0, differs - 100), differs + 100)} || ${without.slice(Math.max(0, differs - 100), differs + 100)}`)
    const more = listed(noteRequest).filter(line => !listed(plainRequest).includes(line))
    check('the list of skills is the one place they part: the chat born before its engine served lists every skill the other lists, and the few more that a window not yet known leaves room for', listed(plainRequest).length > 0 && listed(plainRequest).every(line => listed(noteRequest).includes(line)) && more.length <= 5, `${listed(noteRequest).length} against ${listed(plainRequest).length} lines; more: ${more.map(line => line.slice(0, 40)).join(' | ')}`)
  } finally {
    engineProcess.kill('SIGTERM')
    stopDaemon(serving)
  }

  section('S6 what else refuses a chat’s start still refuses, in its own words, on the home screen')
  for (const [name, model, words] of [
    ['a model of a family with no sign-in', HOSTED, 'model refused (no-credential:anthropic)'],
    ['a model no family declares', 'no-such-model-xyz', 'model refused (not-runnable:unrecognised)'],
    ['the local family named with no server', 'local', 'model refused (unreachable:local)'],
  ] as const) {
    const refusing = await makeWorld({ saved: null })
    const refused = await capture(refusing, `refused-${model}`, '150x40', [at('↑↓ choose', '\r', 'home', 2), at('the chat could not start', '', 'refused', 4)], 'the chat could not start', { argv: ['--model', model], total: 160 })
    check(`${name} (${model}): the home screen stays and says why`, refused.delivered === refused.asked && flat(refused.marks.refused).includes('↑↓ choose') && flat(refused.marks.refused).includes(`▲ the chat could not start — ${words}`), flat(refused.marks.refused).slice(-400))
    stopDaemon(refusing)
  }

  section('S7 a headless run on that model ends as it did')
  {
    const headless = await makeWorld()
    const began = Date.now()
    const ran = spawnSync(NODE, [BIN, '--sovereign', 'run', '--model', MODEL, RAIN], { cwd: headless.cwd, env: { ...headless.env, TERM: 'dumb' }, encoding: 'utf8', timeout: 90_000 })
    check('it says the local road’s sentence and exits 1, with no wait (holds on the parent too)', ran.status === 1 && `${ran.stdout}${ran.stderr}`.includes(`API Error: ${UNLISTED}`) && Date.now() - began < 60_000, `exit ${ran.status} after ${Date.now() - began} ms: ${`${ran.stdout}${ran.stderr}`.slice(-300)}`)
    stopDaemon(headless)
  }

  section('S8 the note an admission already had, of a resumed session whose model has no credential here: in the chat as it was')
  const NO_CREDENTIAL = `the session's model ${HOSTED} has no credential here — the first model send picks the neutral default; /model chooses`
  const lender = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: HOSTED_ANSWER })))
  try {
    const lent = await makeWorld({ saved: HOSTED, key: KEY, provider: lender.url })
    const ran = await capture(lent, 'credential', '150x40', [at('↑↓ choose', '\r', 'home', 2), at(`ready · ${HOSTED_NAME}`, RAIN, 'opened', 6), at(RAIN, '\r', undefined, 2), at(HOSTED_ANSWER, '', 'answered', 4), ...typed(HOSTED_ANSWER, '/exit')], 'Session saved', { total: 260 })
    check('a chat on a hosted model with its credential is answered and saved (holds on the parent too)', ran.delivered === ran.asked && flat(ran.marks.answered).includes(HOSTED_ANSWER) && !flat(ran.marks.answered).includes('has no credential here'), `${ran.delivered}/${ran.asked} ${flat(ran.marks.answered).slice(-300)}`)
    stopDaemon(lent)
    delete lent.env.ANTHROPIC_API_KEY
    lent.env.ANTHROPIC_BASE_URL = DEAD
    const asked = lender.messageRequests().length
    for (const size of ['150x40', '80x40']) {
      const resumed = await capture(lent, 'no-credential', size, [at('Continue Last Session', DOWN, 'home', 3), at('Continue Last Session', '\r', undefined, 3), at('has no credential here', '', 'resumed', 8), ...typed('has no credential here', '/exit')], 'Session saved', { total: 220 })
      const frame = resumed.marks.resumed
      check(`${size}: Continue Last Session with the credential gone opens the chat with its rows and that note, word for word, wrapped and whole, once (holds on the parent too)`, resumed.delivered === resumed.asked && flat(frame).includes(NO_CREDENTIAL) && count(frame, 'has no credential here') === 1 && flat(frame).includes(HOSTED_ANSWER), `${resumed.delivered}/${resumed.asked} ${resumed.note} ${flat(frame).slice(-600)}`)
      check(`${size}: the home screen it came from carried no line of that note (holds on the parent too)`, !flat(resumed.marks.home).includes('has no credential here') && flat(resumed.marks.home).includes('Continue Last Session'), flat(resumed.marks.home).slice(-300))
      stopDaemon(lent)
    }
    const kept = transcriptsOf(lent).map(path => readFileSync(path, 'utf8'))
    check('that note too is the screen\'s alone: no request carried it and the session\'s record holds no line of it (holds on the parent too)', lender.messageRequests().length === asked && !lender.messageRequests().some(request => JSON.stringify(request.body).includes('has no credential here')) && kept.length > 0 && !kept.some(text => text.includes('has no credential here')), `${lender.messageRequests().length} requests against ${asked}; ${kept.length} transcript files`)
  } finally {
    await lender.close()
  }
} finally {
  for (const world of worlds) {
    rmSync(world.root, { recursive: true, force: true })
    rmSync(world.engine.root, { recursive: true, force: true })
  }
}

console.log(`\n${checks - failures} of ${checks} checks hold`)
console.log(failures === 0 ? 'prove-unserved-local-chat-drive: ALL HOLD' : `prove-unserved-local-chat-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

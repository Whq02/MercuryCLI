#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-logins-copy-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const FOLDER = join(SCRATCH, 'orchard')
for (const d of [TEMPLATE, FOLDER]) mkdirSync(d, { recursive: true })
writeFileSync(join(FOLDER, 'README.md'), '# orchard\n')
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const KEEP = process.env.MERCURY_LOGINS_COPY_KEEP === '1'
const FRAMES = process.env.MERCURY_LOGINS_COPY_FRAMES === '1'
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-logins-copy-key-stays-out-of-draft: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [FOLDER])

const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const ROSTER_LEGEND = '↑↓ move · ↵ sign in · esc back'
const CARD_FIELD = 'Paste code here if prompted >'
const CARD_HINT = 'press c to copy the URL'
const CARD_ACK = 'Copied to clipboard'
const FACE_HINT = 'c copies the URL'
const FACE_ACK = 'copied to clipboard'
const OPENAI_FIELD = 'or paste the redirected URL:'
const HANDLES_WAY_OUT = 'c copy · d device · esc cancel'
const HANDLES_EMPTY_PASTE = 'paste: ▌'
const FACE_ROWS = 80
const WARM_TICKS = 25
const LOGINS_ROW_DOWNS = 6
const DOWN = '\x1b[B'
const ESC = '\x1b'
const ENTER = '\r'
const NO_BROWSER = existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true'
const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_TOKEN',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
]

type Send = Record<string, unknown>
type Capture = { home: string; text: string; lines: string[]; status: number; tail: string; payload: Record<string, unknown> }

function freshHome(id: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  return home
}

async function capture(opts: { id: string; home: string; keyed: boolean; sends: Send[]; rows?: number; total?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, ...(opts.keyed ? ['--model', 'claude-sonnet-5'] : [])],
      cwd: FOLDER,
      cols: 120,
      rows: opts.rows ?? 40,
      sends: opts.sends,
      total: opts.total ?? 300,
      out: outPath,
    }),
  )
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['TMUX', 'LC_TERMINAL', 'SSH_CLIENT', 'SSH_TTY', ...PROVIDER_KEYS]) delete env[key]
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...env,
      MERCURY_CONFIG_DIR: opts.home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      ANTHROPIC_BASE_URL: api.url,
      ...(opts.keyed ? { ANTHROPIC_API_KEY: 'fixture-key-000' } : {}),
      BROWSER: NO_BROWSER,
      SSH_CONNECTION: 'proof',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.on('close', status => {
      let text = ''
      let lines: string[] = []
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
        const grid = payload.grid as Array<Array<{ c: string }>>
        lines = grid.map(row => row.map(cell => cell.c).join(''))
        text = lines.join('\n')
      } catch {
      }
      resolvePromise({ home: opts.home, text, lines, status: status ?? 1, tail, payload })
    })
  })
  try {
    await api.close()
  } catch {
  }
  return result
}

type Mark = { label: string; grid: Array<Array<{ c: string }>> }
function marksOf(c: Capture): Mark[] {
  return (c.payload.marks as Mark[] | undefined) ?? []
}
function markText(c: Capture, label: string): string {
  return (marksOf(c).find(m => m.label === label)?.grid ?? []).map(row => row.map(cell => cell.c).join('')).join('\n')
}

function fieldAfter(frame: string, label: string): string | null {
  const line = frame.split('\n').find(l => l.includes(label))
  if (line === undefined) return null
  return line.slice(line.indexOf(label) + label.length).replace(/[\s│]+$/, '').trim()
}
function fieldLength(frame: string, label: string): number | null {
  const held = fieldAfter(frame, label)
  return held === null ? null : held.length
}
function marksLanded(c: Capture, labels: string[]): boolean {
  const seen = new Set(marksOf(c).map(m => m.label))
  return labels.every(l => seen.has(l))
}

function draftDots(frame: string, label: 'code:' | 'paste:'): number | null {
  const m = new RegExp(`${label} (•*)▌`).exec(frame)
  return m === null ? null : m[1]!.length
}

function printFrame(id: string, frame: string): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of frame.split('\n')) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}

function report(id: string, c: Capture, needles: string[], red: boolean): void {
  console.log(`  [FRAMES] ${id}: exit ${c.status} · marks ${marksOf(c).map(m => m.label).join(' → ') || '∅'}`)
  for (const m of marksOf(c)) {
    const frame = m.grid.map(row => row.map(cell => cell.c).join('')).join('\n')
    const hits = frame.split('\n').filter(l => needles.some(n => l.includes(n))).map(l => l.trim())
    console.log(`    · ${m.label}: ${hits.join('  ‖  ') || '(no field/hint/ack line on screen)'}`)
  }
  if (red || FRAMES) {
    for (const m of marksOf(c)) printFrame(`${id} @ ${m.label}`, m.grid.map(row => row.map(cell => cell.c).join('')).join('\n'))
    printFrame(`${id} @ end`, c.text)
    if (red) console.log(`  [TAIL] ${c.tail.trim().slice(-400)}`)
  }
}

const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(join(home, 'daemon'))
function reapHome(home: string): void {
  for (const rec of Object.values(recordsOf(home))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
      }
    }
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
  }
}

const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })
const COPY_BEAT = (): Send[] => [
  { afterPrevTicks: 3, data: '', mark: 'after-c' },
  { afterPrevTicks: 12, data: 'a', mark: 'ack-gone' },
  { afterPrevTicks: 1, data: 'b' },
  { afterPrevTicks: 1, data: 'c' },
  { afterPrevTicks: 3, data: '', mark: 'typed' },
]
const QUIT: Send[] = [
  { afterPrevTicks: 3, data: '\x03' },
  { afterPrevTicks: 2, data: '\x03' },
]
const FACE_TO_ROSTER = (): Send[] => [
  g(READY_LINE, '', { mark: 'face' }),
  ...Array.from({ length: LOGINS_ROW_DOWNS }, (): Send => ({ afterPrevTicks: 2, data: DOWN })),
  { afterPrevTicks: 3, data: ENTER, mark: 'logins-row' },
]
const FACE_TO_CARD = (family: string): Send[] => [
  g(READY_LINE, '', { mark: 'face' }),
  { afterPrevTicks: WARM_TICKS, data: ENTER },
  g(COMPOSER, `/logins ${family}`, { mark: 'chat' }),
  { afterPrevTicks: 4, data: ENTER },
]

console.log('L1 — the /logins card: c copies and never lands in the paste field')
{
  const home = freshHome('card-anthropic')
  const c = await capture({
    id: 'l1-card-anthropic',
    home,
    keyed: true,
    sends: [
      ...FACE_TO_CARD('anthropic'),
      g('Provider readiness', ENTER, { mark: 'card', awaitStableTicks: 3 }),
      g('finish signing in there', 'c', { mark: 'waiting-early' }),
      g(CARD_HINT, 'c', { mark: 'prompt' }),
      ...COPY_BEAT(),
      { afterPrevTicks: 2, data: ESC },
      g(COMPOSER, '', { mark: 'closed', awaitSettleTicks: 4 }),
      ...QUIT,
    ],
  })
  const prompt = markText(c, 'prompt')
  const afterC = markText(c, 'after-c')
  const ackGone = markText(c, 'ack-gone')
  const typed = markText(c, 'typed')
  const closed = markText(c, 'closed')
  const before = failures
  check('L1 the drive walked every screen (the card reached its paste prompt)', marksLanded(c, ['card', 'prompt', 'after-c', 'ack-gone', 'typed', 'closed']) && prompt.includes(CARD_HINT) && prompt.includes(CARD_FIELD), `exit ${c.status}`)
  check('L1 c before the prompt left nothing in the field', fieldAfter(prompt, CARD_FIELD) === '', JSON.stringify(fieldAfter(prompt, CARD_FIELD)))
  check('L1 c on the prompt copies — the ack paints', afterC.includes(CARD_ACK))
  check('L1 THE LAW: the c never lands in the paste field (a leak paints one character)', fieldAfter(afterC, CARD_FIELD) === '', JSON.stringify(fieldAfter(afterC, CARD_FIELD)))
  check('L1 the ack is gone two seconds later and the hint is back', !ackGone.includes(CARD_ACK) && ackGone.includes(CARD_HINT))
  check('L1 a code containing a c still types: three characters, no copy', fieldLength(typed, CARD_FIELD) === 3 && !typed.includes(CARD_ACK), JSON.stringify(fieldAfter(typed, CARD_FIELD)))
  check('L1 esc closes the card back to the composer', closed.includes(COMPOSER) && !closed.includes(CARD_FIELD))
  report('l1', c, [CARD_FIELD, CARD_HINT, CARD_ACK], failures > before)
  reapHome(home)
}

console.log('L2 — the face’s logins layer: c copies and the masked draft stays empty')
{
  const home = freshHome('face-anthropic')
  const c = await capture({
    id: 'l2-face-anthropic',
    home,
    keyed: false,
    rows: FACE_ROWS,
    sends: [
      ...FACE_TO_ROSTER(),
      g(ROSTER_LEGEND, DOWN, { mark: 'roster', awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: ENTER },
      g('the paste fallback appears in a moment', 'c', { mark: 'waiting-early' }),
      g(FACE_HINT, 'c', { mark: 'prompt' }),
      ...COPY_BEAT(),
      { afterPrevTicks: 2, data: ESC },
      g(ROSTER_LEGEND, ESC, { mark: 'back', awaitSettleTicks: 3 }),
      ...QUIT,
    ],
  })
  const roster = markText(c, 'roster')
  const prompt = markText(c, 'prompt')
  const afterC = markText(c, 'after-c')
  const ackGone = markText(c, 'ack-gone')
  const typed = markText(c, 'typed')
  const back = markText(c, 'back')
  const before = failures
  check('L2 the drive walked every screen (the roster opened, the flow reached its paste prompt)', marksLanded(c, ['roster', 'waiting-early', 'prompt', 'after-c', 'ack-gone', 'typed', 'back']) && roster.includes('Claude subscription account') && prompt.includes(FACE_HINT), `exit ${c.status}`)
  check('L2 c before the prompt left nothing behind (the draft line is empty)', draftDots(prompt, 'code:') === 0, String(draftDots(prompt, 'code:')))
  check('L2 c on the prompt copies — the ack paints', afterC.includes(FACE_ACK))
  check('L2 THE LAW: the draft line stays `code: ▌` after the c', draftDots(afterC, 'code:') === 0, String(draftDots(afterC, 'code:')))
  check('L2 the ack is gone two seconds later and the hint is back', !ackGone.includes(FACE_ACK) && ackGone.includes(FACE_HINT))
  check('L2 a code containing a c still types: `code: •••▌`, no copy', draftDots(typed, 'code:') === 3 && !typed.includes(FACE_ACK), String(draftDots(typed, 'code:')))
  check('L2 esc returns to the roster', back.includes(ROSTER_LEGEND) && !back.includes(FACE_HINT))
  report('l2', c, ['code:', FACE_HINT, FACE_ACK], failures > before)
  reapHome(home)
}

console.log('L3 — the /logins card’s OpenAI browser leg: c copies the URL and the field stays empty')
{
  const home = freshHome('card-openai')
  const c = await capture({
    id: 'l3-card-openai',
    home,
    keyed: true,
    sends: [
      ...FACE_TO_CARD('openai'),
      g('Provider readiness', ENTER, { mark: 'card', awaitStableTicks: 3 }),
      g('ChatGPT subscription — browser sign-in', ENTER, { mark: 'arm-pick' }),
      g(OPENAI_FIELD, 'c', { mark: 'wait' }),
      ...COPY_BEAT(),
      { afterPrevTicks: 2, data: ESC },
      g(COMPOSER, '', { mark: 'closed', awaitSettleTicks: 4 }),
      ...QUIT,
    ],
  })
  const wait = markText(c, 'wait')
  const afterC = markText(c, 'after-c')
  const ackGone = markText(c, 'ack-gone')
  const typed = markText(c, 'typed')
  const closed = markText(c, 'closed')
  const before = failures
  check('L3 the drive walked every screen (the browser leg reached its wait screen)', marksLanded(c, ['card', 'arm-pick', 'wait', 'after-c', 'ack-gone', 'typed', 'closed']) && wait.includes(OPENAI_FIELD) && wait.includes('c copies the URL'), `exit ${c.status}`)
  check('L3 c copies — the ack paints', afterC.includes(CARD_ACK))
  check('L3 THE LAW: the c never lands in the paste field', fieldAfter(afterC, OPENAI_FIELD) === '', JSON.stringify(fieldAfter(afterC, OPENAI_FIELD)))
  check('L3 the ack is gone two seconds later', !ackGone.includes(CARD_ACK))
  check('L3 a paste containing a c still types (abc), no copy', fieldAfter(typed, OPENAI_FIELD) === 'abc' && !typed.includes(CARD_ACK), JSON.stringify(fieldAfter(typed, OPENAI_FIELD)))
  check('L3 esc closes the card back to the composer', closed.includes(COMPOSER) && !closed.includes(OPENAI_FIELD))
  report('l3', c, [OPENAI_FIELD, 'c copies the URL', CARD_ACK], failures > before)
  reapHome(home)
}

console.log('L4 — the face’s OpenAI browser leg: c copies and the masked paste stays empty')
{
  const home = freshHome('face-openai')
  const c = await capture({
    id: 'l4-face-openai',
    home,
    keyed: false,
    rows: FACE_ROWS,
    sends: [
      ...FACE_TO_ROSTER(),
      g(ROSTER_LEGEND, ENTER, { mark: 'roster', awaitSettleTicks: 3 }),
      g('ChatGPT subscription — browser sign-in', ENTER, { mark: 'pick' }),
      g(HANDLES_EMPTY_PASTE, 'c', { mark: 'wait' }),
      ...COPY_BEAT(),
      { afterPrevTicks: 2, data: ESC },
      g(ROSTER_LEGEND, ESC, { mark: 'back', awaitSettleTicks: 3 }),
      ...QUIT,
    ],
  })
  const wait = markText(c, 'wait')
  const afterC = markText(c, 'after-c')
  const ackGone = markText(c, 'ack-gone')
  const typed = markText(c, 'typed')
  const back = markText(c, 'back')
  const before = failures
  check('L4 the drive walked every screen (the handles wait pane is up)', marksLanded(c, ['roster', 'pick', 'wait', 'after-c', 'ack-gone', 'typed', 'back']) && wait.includes(HANDLES_WAY_OUT) && draftDots(wait, 'paste:') === 0, `exit ${c.status}`)
  check('L4 c copies — the ack paints', afterC.includes(FACE_ACK))
  check('L4 THE LAW: the paste line stays `paste: ▌` after the c', draftDots(afterC, 'paste:') === 0, String(draftDots(afterC, 'paste:')))
  check('L4 the ack is gone two seconds later and the way out is back', !ackGone.includes(FACE_ACK) && ackGone.includes(HANDLES_WAY_OUT))
  check('L4 a paste containing a c still types: `paste: •••▌`, no copy', draftDots(typed, 'paste:') === 3 && !typed.includes(FACE_ACK), String(draftDots(typed, 'paste:')))
  check('L4 esc returns to the roster', back.includes(ROSTER_LEGEND))
  report('l4', c, ['paste:', HANDLES_WAY_OUT, FACE_ACK], failures > before)
  reapHome(home)
}

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-logins-copy-key-stays-out-of-draft: ALL LAWS HOLD' : `\nprove-logins-copy-key-stays-out-of-draft: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

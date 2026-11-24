#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RESIZE_SETTLE_MS } from '../../src/screen/renderer/constants.ts'
import { projectSlug } from '../../src/sessions/transcripts/sessionStoragePortable.ts'
import { posixPtyDriverOrSkip } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { recordPty, sharedClockMs, type PtyRecord } from '../lib/ptyRecorder.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const ONLY = argAfter('--only')
const KEEP = process.argv.includes('--keep')
const FRAMES = process.argv.includes('--frames')
const SCREENGRAB = join(REPO, 'scripts', 'streaming', 'screengrab.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:9'
const SID = '00000000-5e51-4000-8000-0000000000e5'
const WIDE = 120
const NARROW = 80
const ROWS = 40
const TURNS = 24
const DIFF_LINES = 7
const STREAM_LINES = 300
const STREAM_GAP_MS = 30
const DRAG_STEP_COLUMNS = 4
const DRAG_STEP_MS = 40
const FRAME_BUDGET_MS = RESIZE_SETTLE_MS + 250
const TAIL_MARK = 'TAILMARK-RESIZE-WHOLE'
const ERASE = '\x1b[2J'
const WHOLE_HEAD = '\x1b[H\x1b[0m'
const HOLD_HEAD = '\x1b[?25l'

let failures = 0
let checks = 0
const figures: string[] = []
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  const fix = /through the drag/.test(label)
    ? 'frames must keep flowing while a resize settles: settleResize in src/screen/renderer/instance/resize.ts and onRender in src/screen/renderer/instance/frame-loop.ts'
    : /holding paint/.test(label)
      ? 'holdingClipPaint in src/screen/renderer/frame-writer.ts must paint the frame it holds, cut to the new size, from the top left'
      : /one write/.test(label)
        ? 'the display erase of a shrink rides the whole-frame write: resizeEraseDue in src/screen/renderer/instance/frame-loop.ts'
        : /blank band|equals the screen before/.test(label)
          ? 'a row keeps a height from another width: Ratchet in src/screen/theme/Ratchet.tsx and the row heights in src/screen/virtual-message-list/useVirtualScroll.ts'
          : 'the settled repaint is applySettledResize in src/screen/renderer/instance/resize.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail === '' ? '' : `${detail.slice(0, 1400)} | `}fix: ${fix}; rerun with --frames --keep to read the screens and the recorded writes`}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const driver = posixPtyDriverOrSkip('prove-resize-repaints-whole')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}
process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'resize-whole-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
const prose = (t: number, part: string): string => `T${pad(t)} ${part}: the ledger sweep holds steady against the recorded baseline while the quiet harbour keeps its lamps lit and the tide table is read aloud once more for part ${t}.`
const diffLine = (sign: string, t: number, line: number): string => `${sign}  const row${pad(line)} = settle(anchor, generation, viewport) // part ${pad(t)} line ${pad(line)}`

function seededHome(tag: string): string {
  const home = join(ROOT, `home-${tag}`)
  seedFirstRun(home, [CWD])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ activity: { tips: { enabled: false } } }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  const rows: Record<string, unknown>[] = []
  let seq = 0
  let prev: string | null = null
  let clock = Date.parse('2026-06-19T08:00:00.000Z')
  const push = (extra: Record<string, unknown>): void => {
    const uuid = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
    clock += 1500
    rows.push({ isSidechain: false, entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', parentUuid: prev, uuid, timestamp: new Date(clock).toISOString(), ...extra })
    prev = uuid
  }
  const assistant = (id: string, content: unknown[], stop: string): Record<string, unknown> => ({
    type: 'assistant',
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } },
  })
  for (let t = 1; t <= TURNS; t++) {
    const file = join(CWD, `part-${pad(t)}.ts`)
    const removed = Array.from({ length: DIFF_LINES }, (_, i) => diffLine('-', t, i + 1))
    const added = Array.from({ length: DIFF_LINES }, (_, i) => diffLine('+', t, i + 1).replace('settle(', 'settled('))
    const original = removed.map(line => line.slice(1)).join('\n') + '\n'
    const id = `toolu_T${pad(t)}_edit`
    push({ type: 'user', message: { role: 'user', content: prose(t, 'ask') } })
    push(assistant(`T${pad(t)}_open`, [{ type: 'text', text: prose(t, 'opening') }], 'tool_use'))
    push(assistant(`T${pad(t)}_edit`, [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'settle(', new_string: 'settled(', replace_all: true } }], 'tool_use'))
    push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      toolUseResult: { filePath: file, oldString: 'settle(', newString: 'settled(', originalFile: original, structuredPatch: [{ oldStart: 1, oldLines: DIFF_LINES, newStart: 1, newLines: DIFF_LINES, lines: [...removed, ...added] }], userModified: false, replaceAll: true },
    })
    push(assistant(`T${pad(t)}_close`, [{ type: 'text', text: t === TURNS ? `T${pad(t)} closing: every part is through. ${TAIL_MARK}` : prose(t, 'closing') }], 'end_turn'))
  }
  const transcript = join(home, 'projects', projectSlug(CWD), `${SID}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, encodeSeedTranscript(rows, SID))
  return home
}

function childEnv(home: string, tee: string, modelBase: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CRITTER: 'clam',
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'Apple_Terminal',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_TMPDIR: join(ROOT, 'product-tmp'),
    INK_WRITE_TEE: tee,
    INK_WRITE_TEE_FULL: '1',
    ANTHROPIC_BASE_URL: modelBase,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV', 'MERCURY_DEMO', 'TERMINAL_EMULATOR',
    '__CFBundleIdentifier', 'TERM_PROGRAM_VERSION', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL',
    'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'CI', 'NO_COLOR', 'TMUX', 'WT_SESSION',
  ]) {
    delete env[k]
  }
  return env
}

type Resize = { atMs: number; cols: number; rows: number }
type TeeWrite = { ts: number; content: string }
type Stage = {
  records: PtyRecord[]
  resize: (cols: number, rows: number) => void
  send: (text: string) => void
  wait: (ms: number) => Promise<void>
  quiet: (ms: number, ceilingMs: number) => Promise<void>
  until: (what: string, ceilingMs: number, seen: () => boolean) => Promise<void>
  wire: () => string
  fixture: FixtureApi | null
}
type Run = { id: string; outputs: PtyRecord[]; resizes: Resize[]; tee: TeeWrite[]; emits: number }

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function drive(id: string, turns: ScriptedTurn[] | null, act: (stage: Stage) => Promise<void>): Promise<Run> {
  const home = seededHome(id)
  const tee = join(ROOT, `${id}.tee.jsonl`)
  const fixture = turns === null ? null : await startFixtureApi(turns)
  const recording = recordPty({ argv: [NODE, BIN, '--resume', SID], cwd: CWD, env: childEnv(home, tee, fixture === null ? DEAD : fixture.url), cols: WIDE, rows: ROWS, path: join(ROOT, `${id}.pty.bin`) })
  const resizes: Resize[] = []
  const outputs = (): PtyRecord[] => recording.records.filter(row => row.direction === 'output')
  const stage: Stage = {
    records: recording.records,
    resize: (cols, rows) => {
      resizes.push({ atMs: recording.resize(cols, rows), cols, rows })
    },
    send: text => {
      recording.send(text)
    },
    wait: pause,
    quiet: async (ms, ceilingMs) => {
      const end = sharedClockMs() + ceilingMs
      while (sharedClockMs() < end && sharedClockMs() - (outputs().at(-1)?.atMs ?? 0) < ms) await pause(10)
    },
    until: async (what, ceilingMs, seen) => {
      const end = sharedClockMs() + ceilingMs
      while (!seen()) {
        if (sharedClockMs() > end) throw new Error(`${id}: ${what} did not happen within ${ceilingMs} ms; the last bytes on the wire read ${JSON.stringify(Buffer.concat(outputs().slice(-6).map(row => row.bytes)).toString('utf8').slice(-400))}`)
        await pause(20)
      }
    },
    wire: () => Buffer.concat(outputs().map(row => row.bytes)).toString('utf8'),
    fixture,
  }
  let ended = Number.POSITIVE_INFINITY
  try {
    await act(stage)
    ended = sharedClockMs()
  } finally {
    await recording.close()
    if (fixture !== null) await fixture.close()
  }
  const written: TeeWrite[] = existsSync(tee)
    ? readFileSync(tee, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Partial<TeeWrite>).filter((row): row is TeeWrite => typeof row.ts === 'number' && typeof row.content === 'string')
    : []
  return { id, outputs: outputs().filter(row => row.atMs <= ended), resizes, tee: written, emits: fixture === null ? 0 : fixture.pacedEmits.length }
}

type Screen = { rows: string[]; cursor: { x: number; y: number } }

function screensOf(tag: string, records: readonly PtyRecord[], fromMs: number, cols: number, rows: number, stops: number[], cursor?: { x: number; y: number }): Screen[] {
  const file = join(ROOT, `${tag}.drive.jsonl`)
  const head = cursor === undefined ? '' : `\x1b[${cursor.y + 1};${cursor.x + 1}H`
  const lines = [{ ts: fromMs, b64: Buffer.from(head).toString('base64') }, ...records.map(row => ({ ts: row.atMs, b64: row.bytes.toString('base64') }))]
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  const grabbed = spawnSync(driver.python, [SCREENGRAB, file, String(cols), String(rows), ...stops.map(String)], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
  if (grabbed.status !== 0) throw new Error(`screengrab failed for ${tag}: ${grabbed.stderr}`)
  const screens = (JSON.parse(grabbed.stdout) as { screens: Array<{ atMs: number; rows: string[]; cursor: { x: number; y: number } }> }).screens
  return stops.map(stop => {
    const found = screens.find(screen => screen.atMs === stop)
    if (found === undefined) throw new Error(`screengrab returned no screen at ${stop} for ${tag}`)
    return { rows: found.rows, cursor: found.cursor }
  })
}

const blankRow = (row: string): boolean => row.replace(/[│┃]/g, '').trim() === ''

function longestBlankRun(rows: readonly string[], from: number, to: number): { length: number; at: number } {
  let best = { length: 0, at: -1 }
  let start = -1
  for (let at = from; at <= to; at++) {
    const blank = at < to && blankRow(rows[at] ?? '')
    if (blank && start < 0) start = at
    if (!blank && start >= 0) {
      if (at - start > best.length) best = { length: at - start, at: start }
      start = -1
    }
  }
  return best
}

const show = (title: string, rows: readonly string[]): void => {
  if (FRAMES) console.log(`--- ${title}\n${rows.map(row => `  │${row}`).join('\n')}`)
}

function byteOffsets(outputs: readonly PtyRecord[]): { bytes: Buffer; timeOf: (offset: number) => number } {
  const starts: number[] = []
  let total = 0
  for (const row of outputs) {
    starts.push(total)
    total += row.bytes.length
  }
  return {
    bytes: Buffer.concat(outputs.map(row => row.bytes)),
    timeOf: offset => {
      let at = 0
      while (at + 1 < starts.length && starts[at + 1]! <= offset) at++
      return outputs[at]?.atMs ?? Number.NaN
    },
  }
}

type Extent = { startMs: number; endMs: number }

function extentOnWire(outputs: readonly PtyRecord[], afterMs: number, write: string): Extent | null {
  const window = outputs.filter(row => row.atMs >= afterMs)
  const wire = byteOffsets(window)
  const want = Buffer.from(write, 'utf8')
  const at = wire.bytes.indexOf(want)
  if (at < 0) return null
  return { startMs: wire.timeOf(at), endMs: wire.timeOf(at + want.length - 1) }
}

const settleBudget = `${FRAME_BUDGET_MS} ms (the settle wait of ${RESIZE_SETTLE_MS} ms and 250 ms for the repaint)`

console.log('============================================================')
console.log(' A resize repaints the screen whole: at rest and while a reply streams')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')

if (ONLY === undefined || ONLY === 'rest') {
  section(`at rest: ${TURNS} turns with file edits, ${WIDE} columns to ${NARROW} and back, three times`)
  const run = await drive('rest', null, async stage => {
    await stage.until('the transcript\'s tail', 60_000, () => stage.wire().includes(TAIL_MARK))
    await stage.quiet(1200, 15_000)
    for (let round = 0; round < 3; round++) {
      for (const cols of [NARROW, WIDE]) {
        stage.resize(cols, ROWS)
        await stage.wait(RESIZE_SETTLE_MS + 400)
        await stage.quiet(500, 6000)
      }
    }
  })
  check('the drive resized six times', run.resizes.length === 6, `${run.resizes.length} resizes`)
  const first = run.resizes[0]?.atMs ?? Number.POSITIVE_INFINITY
  const before = screensOf('rest-before', run.outputs.filter(row => row.atMs < first), run.outputs[0]?.atMs ?? 0, WIDE, ROWS, [-1])[0]!
  show('before the first resize', before.rows)
  const transcriptRows = before.rows.filter(row => /T\d\d (?:ask|opening|closing)|const row\d\d/.test(row)).length
  check('the screen before the first resize shows the transcript\'s tail with a file\'s diff in it', before.rows.some(row => row.includes(TAIL_MARK)) && before.rows.some(row => /const row\d\d = settled?\(/.test(row)) && transcriptRows >= 8, `${transcriptRows} transcript rows\n${before.rows.join('\n')}`)
  let prior = before
  const lastByte: number[] = []
  const erases = run.tee.filter(write => write.ts >= Math.floor(first) - 1 && write.content.includes(ERASE))
  for (const [index, resize] of run.resizes.entries()) {
    const label = `resize ${index + 1} (${index % 2 === 0 ? WIDE : NARROW} to ${resize.cols})`
    const until = run.resizes[index + 1]?.atMs ?? Number.POSITIVE_INFINITY
    const records = run.outputs.filter(row => row.atMs >= resize.atMs && row.atMs < until)
    const holdWrite = run.tee.find(write => write.ts >= Math.floor(resize.atMs) - 1 && write.content.startsWith(HOLD_HEAD))
    const wholeWrite = run.tee.find(write => write.ts >= Math.floor(resize.atMs) - 1 && write.content.includes(WHOLE_HEAD))
    const hold = holdWrite === undefined ? null : extentOnWire(records, resize.atMs, holdWrite.content)
    const whole = wholeWrite === undefined ? null : extentOnWire(records, resize.atMs, wholeWrite.content)
    check(`${label}: one holding paint and one whole frame reach the wire`, hold !== null && whole !== null, `hold ${hold === null ? 'missing' : 'seen'}, whole frame ${whole === null ? 'missing' : 'seen'} among ${records.length} reads`)
    if (hold === null || whole === null) continue
    const stops = [hold.endMs - resize.atMs + 0.25, whole.endMs - resize.atMs + 0.25, -1]
    const [held, repainted, settled] = screensOf(`rest-${index + 1}`, records, resize.atMs, resize.cols, ROWS, stops, prior.cursor)
    const cut = prior.rows.map(row => row.slice(0, resize.cols).trimEnd())
    const differing = cut.flatMap((row, at) => (row === (held!.rows[at] ?? '').trimEnd() ? [] : [at]))
    check(`${label}: the holding paint shows the frame that stood, cut to the new width, row for row`, differing.length === 0, `${differing.length} rows differ, the first is row ${differing[0]}: stood ${JSON.stringify(cut[differing[0] ?? 0])}, held ${JSON.stringify(held!.rows[differing[0] ?? 0])}`)
    for (const [name, screen] of [['the holding paint', held!], ['the whole frame', repainted!], ['the settled screen', settled!]] as const) {
      const run3 = longestBlankRun(screen.rows, 1, ROWS - 5)
      check(`${label}: ${name} has no blank band`, run3.length < 3, `${run3.length} blank rows from row ${run3.at}\n${screen.rows.join('\n')}`)
    }
    const ms = whole.endMs - resize.atMs
    lastByte.push(ms)
    check(`${label}: the whole frame's last byte is on the wire within ${settleBudget}`, ms <= FRAME_BUDGET_MS, `${ms.toFixed(1)} ms`)
    show(`${label}: held`, held!.rows)
    show(`${label}: settled`, settled!.rows)
    prior = settled!
  }
  figures.push(`at rest: ms from a resize to the whole frame's last byte: ${lastByte.map(ms => ms.toFixed(0)).join(', ')}`)
  check('every shrink erases the display once, and the erase leaves the process in one write with the whole frame behind it', erases.length === 3 && erases.every(write => write.content.includes(ERASE + WHOLE_HEAD)), `${erases.length} writes hold an erase; their heads read ${erases.map(write => JSON.stringify(write.content.slice(0, 24))).join(' ')}`)
  const moved = before.rows.flatMap((row, at) => (row === prior.rows[at] ? [] : [at]))
  check('after three round trips the settled screen equals the screen before the first resize, row for row', moved.length === 0, `${moved.length} rows differ, the first is row ${moved[0]}: before ${JSON.stringify(before.rows[moved[0] ?? 0])}, after ${JSON.stringify(prior.rows[moved[0] ?? 0])}\n${prior.rows.join('\n')}`)
}

if (ONLY === undefined || ONLY === 'stream') {
  section(`while a reply streams: ${STREAM_LINES} lines, the window dragged from ${WIDE} columns to ${NARROW} and back, three times`)
  const deltas = Array.from({ length: STREAM_LINES }, (_, i) => `rv-stream-line-${pad(i, 3)} the ledger sweep holds steady against the recorded baseline\n`)
  const drags: Array<{ from: number; to: number; first: number; last: number }> = []
  const run = await drive('stream', [
    { kind: 'text', text: 'Resize scene', whenBody: 'Write a concise title for this coding session' },
    { kind: 'text', text: 'Resize scene', whenBody: 'Write a concise title for this coding session' },
    { kind: 'paced', deltas, gapMs: STREAM_GAP_MS, settleDelayMs: 600, whenModel: 'opus-4' },
  ], async stage => {
    await stage.until('the transcript\'s tail', 60_000, () => stage.wire().includes(TAIL_MARK))
    await stage.quiet(1200, 15_000)
    stage.send('stream the long reply')
    await stage.wait(400)
    stage.send('\r')
    await stage.until('the reply\'s twentieth line', 30_000, () => (stage.fixture?.pacedEmits.length ?? 0) >= 20)
    let columns = WIDE
    for (let round = 0; round < 3; round++) {
      for (const target of [NARROW, WIDE]) {
        const step = target < columns ? -DRAG_STEP_COLUMNS : DRAG_STEP_COLUMNS
        const from = columns
        const first = sharedClockMs()
        while (columns !== target) {
          columns += step
          stage.resize(columns, ROWS)
          if (columns !== target) await stage.wait(DRAG_STEP_MS)
        }
        drags.push({ from, to: target, first, last: sharedClockMs() })
        await stage.wait(RESIZE_SETTLE_MS + 500)
      }
    }
    await stage.until('the reply\'s last line', 40_000, () => (stage.fixture?.pacedEmits.length ?? 0) >= STREAM_LINES)
    await stage.quiet(1000, 8000)
  })
  check('the reply streamed whole', run.emits === STREAM_LINES, `${run.emits} of ${STREAM_LINES} lines left the stand-in model`)
  check('the drive dragged six times', drags.length === 6, `${drags.length} drags`)
  const lineOf = (rows: readonly string[]): number => Math.max(-1, ...rows.flatMap(row => [...row.matchAll(/rv-stream-line-(\d{3})/g)].map(match => Number(match[1]))))
  const lastByte: number[] = []
  const held: number[] = []
  for (const [index, drag] of drags.entries()) {
    const label = `drag ${index + 1} (${drag.from} to ${drag.to})`
    const steps = run.resizes.filter(resize => resize.atMs >= drag.first - 1 && resize.atMs <= drag.last + 1)
    const firstStep = steps[0]
    const lastStep = steps.at(-1)
    check(`${label}: its steps were recorded`, firstStep !== undefined && lastStep !== undefined && steps.length === Math.abs(drag.to - drag.from) / DRAG_STEP_COLUMNS, `${steps.length} steps`)
    if (firstStep === undefined || lastStep === undefined) continue
    const next = run.resizes.find(resize => resize.atMs > lastStep.atMs)?.atMs ?? Number.POSITIVE_INFINITY
    const during = run.outputs.filter(row => row.atMs >= firstStep.atMs && row.atMs < lastStep.atMs)
    const after = run.outputs.filter(row => row.atMs >= lastStep.atMs && row.atMs < next)
    const wholeWrite = run.tee.find(write => write.ts >= Math.floor(lastStep.atMs) - 1 && write.content.includes(WHOLE_HEAD))
    const whole = wholeWrite === undefined ? null : extentOnWire(after, lastStep.atMs, wholeWrite.content)
    check(`${label}: one whole frame follows the drag`, whole !== null, 'no whole-frame write reached the wire after the last step')
    if (whole === null) continue
    const tail = during.at(-1)
    const dragScreens = tail === undefined ? [] : screensOf(`stream-drag-${index + 1}`, during, firstStep.atMs, firstStep.cols, ROWS, [Math.min(8, DRAG_STEP_MS / 2), tail.atMs - firstStep.atMs + 0.25])
    const [opened, closed] = dragScreens
    const advanced = opened === undefined || closed === undefined ? 0 : lineOf(closed.rows) - lineOf(opened.rows)
    const silence = Math.max(0, ...[...during, ...after.filter(row => row.atMs <= whole.startMs)].map((row, at, all) => row.atMs - (all[at - 1]?.atMs ?? firstStep.atMs)))
    held.push(silence)
    check(
      `${label}: the reply keeps arriving through the drag (${Math.round(lastStep.atMs - firstStep.atMs)} ms of it): the screen gains lines before the drag ends`,
      advanced >= 3,
      `the reply stood on line ${opened === undefined ? '?' : lineOf(opened.rows)} when the drag began and on line ${closed === undefined ? '?' : lineOf(closed.rows)} when it ended; the wire was silent for ${silence.toFixed(0)} ms`,
    )
    if (closed !== undefined) {
      const band = longestBlankRun(closed.rows, 1, ROWS - 5)
      check(`${label}: the screen at the end of the drag has no blank band`, band.length < 3, `${band.length} blank rows from row ${band.at}\n${closed.rows.join('\n')}`)
      show(`${label}: at the end of the drag`, closed.rows)
    }
    const ms = whole.endMs - lastStep.atMs
    lastByte.push(ms)
    check(`${label}: the whole frame's last byte is on the wire within ${settleBudget} of the last step`, ms <= FRAME_BUDGET_MS, `${ms.toFixed(1)} ms`)
    const [settled] = screensOf(`stream-settled-${index + 1}`, after, lastStep.atMs, lastStep.cols, ROWS, [whole.endMs - lastStep.atMs + 300])
    const band = longestBlankRun(settled!.rows, 1, ROWS - 5)
    check(`${label}: the settled screen shows the reply and has no blank band`, lineOf(settled!.rows) >= 0 && band.length < 3, `the newest reply line on screen is ${lineOf(settled!.rows)}; ${band.length} blank rows from row ${band.at}\n${settled!.rows.join('\n')}`)
    show(`${label}: settled`, settled!.rows)
  }
  figures.push(`streaming: ms from a drag's last step to the whole frame's last byte: ${lastByte.map(ms => ms.toFixed(0)).join(', ')}`)
  figures.push(`streaming: longest silence on the wire from a drag's first step to its whole frame: ${held.map(ms => ms.toFixed(0)).join(', ')} ms`)
}

for (const line of figures) console.log(`  [FIGURE] ${line}`)
if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`  kept: ${ROOT}`)
console.log(failures === 0 ? `\n✅ a resize repaints the screen whole (${checks} checks)` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)

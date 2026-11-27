#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRUECOLOR_QUERY } from '../../src/screen/renderer/colorize.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const RENDER = join(HERE, 'render-final-screen.py')
const PY = '/usr/bin/python3'
const COLS = 120
const ROWS = 44

const SENTINEL = '\x1b[c'
const EXPECTED_REQUEST = TRUECOLOR_QUERY + SENTINEL
const ECHO_REPLY = '\x1bP1$r0;48:2::1:2:3m\x1b\\\x1b[?62;22c'
const ECHO_ITERM2_REPLY = '\x1bP1$r0;48:2:1:1:2:3m\x1b\\\x1b[?62;22c'
const ECHO_BEL_REPLY = '\x1bP1$r48;2;1;2;3m\x07\x1b[?62;22c'
const ZERO_M_REPLY = '\x1bP1$r0m\x1b\\\x1b[?62;22c'
const REFUSED_REPLY = '\x1bP0$r\x1b\\\x1b[?62;22c'
const SENTINEL_REPLY = '\x1b[?62;22c'
const SILENCE_MIN_MS = 35
const SILENCE_MAX_MS = 250
const ANSWERED_MAX_MS = 1000
const BOOTSTRAP = [
  "import { resolve } from 'node:path'",
  "import { pathToFileURL } from 'node:url'",
  'const [splashPath, colsArg, rowsArg] = process.argv.slice(1)',
  'const cols = Number(colsArg) || 120',
  'const rows = Number(rowsArg) || 44',
  "Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })",
  "Object.defineProperty(process.stdout, 'columns', { get: () => cols, configurable: true })",
  "Object.defineProperty(process.stdout, 'rows', { get: () => rows, configurable: true })",
  "const noop = (...a) => { const cb = a[a.length - 1]; if (typeof cb === 'function') cb(); return true }",
  'process.stdout.cursorTo = noop',
  'process.stdout.clearLine = noop',
  'process.stdout.clearScreenDown = noop',
  "Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })",
  'process.stdin.setRawMode = () => process.stdin',
  'await import(pathToFileURL(resolve(splashPath)).href)',
].join('\n')

type Screen = { cols: number; rows: number; text: string[]; styles: string[]; palette: string[] }

interface RunOutcome {
  exitCode: number | null
  raw: string
  prePaint: string
  firstFrame: string
  firstScreen: Screen | null
  requestCount: number
  requestBeforePaint: boolean
  firstPaintMs: number | null
  queryToPaintMs: number | null
  receipt: Record<string, unknown> | null
  menuShownBeforeEnter: boolean
}

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) passed++
  else failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

function onlcr(text: string): Buffer {
  const src = Buffer.from(text, 'utf8')
  const out: number[] = []
  for (const byte of src) {
    if (byte === 0x0a) out.push(0x0d)
    out.push(byte)
  }
  return Buffer.from(out)
}

function renderFrame(home: string, frameBytes: string): Screen | null {
  if (frameBytes === '') return null
  const tee = join(home, 'first-frame.raw')
  writeFileSync(tee, onlcr(frameBytes))
  const res = spawnSync(PY, [RENDER, tee, String(COLS), String(ROWS)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  })
  if (res.status !== 0) return null
  return JSON.parse(res.stdout) as Screen
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = 0
  for (;;) {
    const idx = haystack.indexOf(needle, at)
    if (idx === -1) return count
    count++
    at = idx + needle.length
  }
}

function hasPrintable(bytes: string): boolean {
  const stripped = bytes
    .replace(/\x1b\[[0-9;?<=>]*[A-Za-z]/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[78]/g, '')
  return stripped.length > 0
}

async function runArm(opts: {
  reply: string | readonly string[] | null
  replyDelayMs?: number
  splitGapMs?: number
  enterDelayMs?: number
  extraEnv?: Record<string, string>
  sendEnter?: boolean
}): Promise<RunOutcome> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'splash-asks-once-')))
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    MERCURY_HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_FULLSCREEN: '0',
    MERCURY_LAUNCH_RIPPLE: '0',
    MERCURY_REDUCED_MOTION: '1',
    MERCURY_SPLASH_IDLE_MS: '5000',
    ...opts.extraEnv,
  }
  const sendEnter = opts.sendEnter ?? true
  try {
    return await new Promise<RunOutcome>(resolveRun => {
      const startedAt = performance.now()
      const child = spawn('node', ['--input-type=module', '-e', BOOTSTRAP, SPLASH, String(COLS), String(ROWS)], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let raw = ''
      let replied = false
      let enterSent = false
      let querySeenAt: number | null = null
      let firstPaintAt: number | null = null
      let firstFrameEnd = -1
      let menuShownBeforeEnter = false

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 6000)

      child.stdout.on('data', (chunk: Buffer) => {
        const now = performance.now()
        raw += chunk.toString('latin1')
        if (querySeenAt === null && raw.includes(EXPECTED_REQUEST)) {
          querySeenAt = now
          if (!replied && opts.reply !== null) {
            replied = true
            const delay = opts.replyDelayMs ?? 0
            const sendReply = (): void => {
              if (typeof opts.reply === 'string') {
                if (!child.killed && child.exitCode === null) child.stdin.write(opts.reply)
              } else {
                const parts = opts.reply!
                const gap = opts.splitGapMs ?? 8
                parts.forEach((part, idx) => {
                  setTimeout(() => {
                    if (!child.killed && child.exitCode === null) child.stdin.write(part)
                  }, idx * gap)
                })
              }
            }
            if (delay > 0) setTimeout(sendReply, delay)
            else sendReply()
          }
        }
        const firstSyncEnd = raw.indexOf('\x1b[?2026l')
        if (firstPaintAt === null && firstSyncEnd !== -1) {
          firstPaintAt = now
          firstFrameEnd = firstSyncEnd + '\x1b[?2026l'.length
          if (sendEnter && !enterSent) {
            enterSent = true
            setTimeout(() => {
              if (raw.includes('boot menu')) menuShownBeforeEnter = true
              if (!child.killed && child.exitCode === null) child.stdin.write('\r')
            }, opts.enterDelayMs ?? 35)
          }
        }
      })

      child.on('close', exitCode => {
        clearTimeout(killTimer)
        const paintStart = raw.indexOf('\x1b[?1049h')
        const prePaint = paintStart >= 0 ? raw.slice(0, paintStart) : raw
        const firstFrame = paintStart >= 0 && firstFrameEnd > paintStart ? raw.slice(paintStart, firstFrameEnd) : ''
        const reqIdx = raw.indexOf(EXPECTED_REQUEST)
        const requestCount = countOccurrences(raw, EXPECTED_REQUEST)
        const requestBeforePaint = reqIdx >= 0 && paintStart >= 0 && reqIdx + EXPECTED_REQUEST.length <= paintStart
        const receiptPath = join(home, 'splash-action.json')
        let receipt: Record<string, unknown> | null = null
        if (existsSync(receiptPath)) {
          try {
            receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
          } catch {
            receipt = null
          }
        }
        const firstScreen = renderFrame(home, firstFrame)
        resolveRun({
          exitCode,
          raw,
          prePaint,
          firstFrame,
          firstScreen,
          requestCount,
          requestBeforePaint,
          firstPaintMs: firstPaintAt === null ? null : Math.round(firstPaintAt - startedAt),
          queryToPaintMs: querySeenAt !== null && firstPaintAt !== null ? Math.round(firstPaintAt - querySeenAt) : null,
          receipt,
          menuShownBeforeEnter,
        })
      })
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('============================================================')
console.log(' splash — asks the terminal once for 24-bit colour and hands the answer on')
console.log('============================================================')

section('§1 query arms — echo, BEL echo, split echo, 0m, refusal, sentinel alone, silence')
{
  const echo = await runArm({ reply: ECHO_REPLY })
  check('echo: writes TRUECOLOR_QUERY + sentinel exactly once', echo.requestCount === 1, `count=${echo.requestCount}`)
  check('echo: writes the request before the first paint and writes nothing printable before paint', echo.requestBeforePaint && !hasPrintable(echo.prePaint), `beforePaint=${echo.requestBeforePaint} prePaint=${JSON.stringify(echo.prePaint.slice(0, 80))}`)
  check('echo: first painted screen is the 24-bit tier (38;2; present, no 38;5;, cell palette holds dd4444)', echo.firstFrame.includes('\x1b[38;2;') && !echo.firstFrame.includes('\x1b[38;5;') && echo.firstScreen !== null && echo.firstScreen.palette.some(p => p.startsWith('dd4444|')), `has38_2=${echo.firstFrame.includes('\x1b[38;2;')} has38_5=${echo.firstFrame.includes('\x1b[38;5;')} palette=${JSON.stringify(echo.firstScreen?.palette.slice(0, 6))}`)
  check(`echo: first paint finishes promptly (${echo.queryToPaintMs ?? 'no-query'}ms after query, ${echo.firstPaintMs}ms total)`, echo.queryToPaintMs !== null && echo.queryToPaintMs <= ANSWERED_MAX_MS, `queryToPaintMs=${echo.queryToPaintMs}`)
  check('echo: DCS reply bytes never trigger handleKey and Enter launches cleanly (exit 20)', !echo.menuShownBeforeEnter && echo.exitCode === 20, `menuShown=${echo.menuShownBeforeEnter} exit=${echo.exitCode}`)
  check('echo (Windows Terminal 1.24): splash-action.json carries truecolor: true', echo.receipt?.truecolor === true, JSON.stringify(echo.receipt))

  const echoIterm2 = await runArm({ reply: ECHO_ITERM2_REPLY })
  check('echo (iTerm2 3.7.6, colour space 1): paints 24-bit tier, Enter exits 20, writes truecolor: true', echoIterm2.requestCount === 1 && echoIterm2.requestBeforePaint && echoIterm2.firstFrame.includes('\x1b[38;2;') && !echoIterm2.firstFrame.includes('\x1b[38;5;') && !echoIterm2.menuShownBeforeEnter && echoIterm2.receipt?.truecolor === true && echoIterm2.exitCode === 20, `count=${echoIterm2.requestCount} exit=${echoIterm2.exitCode} receipt=${JSON.stringify(echoIterm2.receipt)}`)

  const echoBel = await runArm({ reply: ECHO_BEL_REPLY })
  check('BEL echo: paints 24-bit tier and writes truecolor: true', echoBel.requestCount === 1 && echoBel.requestBeforePaint && echoBel.firstFrame.includes('\x1b[38;2;') && !echoBel.firstFrame.includes('\x1b[38;5;') && echoBel.receipt?.truecolor === true && echoBel.exitCode === 20, `count=${echoBel.requestCount} exit=${echoBel.exitCode} receipt=${JSON.stringify(echoBel.receipt)}`)

  const echoSplit = await runArm({ reply: ['\x1bP1$r0;48:2', '::1:2:3m\x1b\\', '\x1b[?62;22c'] })
  check('split echo: coalesces across chunks, paints 24-bit, never leaks keys, writes truecolor: true', echoSplit.requestCount === 1 && echoSplit.firstFrame.includes('\x1b[38;2;') && !echoSplit.menuShownBeforeEnter && echoSplit.receipt?.truecolor === true && echoSplit.exitCode === 20, `count=${echoSplit.requestCount} exit=${echoSplit.exitCode} receipt=${JSON.stringify(echoSplit.receipt)}`)

  const zeroM = await runArm({ reply: ZERO_M_REPLY })
  check('0m: writes the request exactly once before the first paint', zeroM.requestCount === 1 && zeroM.requestBeforePaint, `count=${zeroM.requestCount} beforePaint=${zeroM.requestBeforePaint}`)
  check('0m: first painted screen is the 256 tier (38;5; present, no 38;2;)', zeroM.firstFrame.includes('\x1b[38;5;') && !zeroM.firstFrame.includes('\x1b[38;2;') && zeroM.firstScreen !== null, `has38_5=${zeroM.firstFrame.includes('\x1b[38;5;')} has38_2=${zeroM.firstFrame.includes('\x1b[38;2;')}`)
  check('0m: DCS reply never triggers handleKey and Enter launches cleanly (exit 20)', !zeroM.menuShownBeforeEnter && zeroM.exitCode === 20, `menuShown=${zeroM.menuShownBeforeEnter} exit=${zeroM.exitCode}`)
  check('0m: splash-action.json carries truecolor: false', zeroM.receipt?.truecolor === false, JSON.stringify(zeroM.receipt))

  const refused = await runArm({ reply: REFUSED_REPLY })
  check('DCS 0 $ r refusal: paints 256 tier, Enter exits 20, receipt carries truecolor: false', refused.requestCount === 1 && refused.requestBeforePaint && refused.firstFrame.includes('\x1b[38;5;') && !refused.firstFrame.includes('\x1b[38;2;') && refused.exitCode === 20 && refused.receipt?.truecolor === false, `count=${refused.requestCount} exit=${refused.exitCode} receipt=${JSON.stringify(refused.receipt)}`)

  const sentinel = await runArm({ reply: SENTINEL_REPLY })
  check('sentinel alone: writes the request exactly once before the first paint', sentinel.requestCount === 1 && sentinel.requestBeforePaint, `count=${sentinel.requestCount} beforePaint=${sentinel.requestBeforePaint}`)
  check('sentinel alone: first painted screen is the 256 tier', sentinel.firstFrame.includes('\x1b[38;5;') && !sentinel.firstFrame.includes('\x1b[38;2;') && sentinel.firstScreen !== null)
  check('sentinel alone: Enter launches cleanly (exit 20)', sentinel.exitCode === 20, `exit=${sentinel.exitCode}`)
  check('sentinel alone: splash-action.json carries truecolor: false', sentinel.receipt?.truecolor === false, JSON.stringify(sentinel.receipt))

  const silence = await runArm({ reply: null })
  check('silence: writes the request exactly once before the first paint', silence.requestCount === 1 && silence.requestBeforePaint, `count=${silence.requestCount} beforePaint=${silence.requestBeforePaint}`)
  check(`silence: first paint waits for the bound once (${silence.queryToPaintMs ?? 'no-query'}ms, target ${SILENCE_MIN_MS}..${SILENCE_MAX_MS}ms)`, silence.queryToPaintMs !== null && silence.queryToPaintMs >= SILENCE_MIN_MS && silence.queryToPaintMs <= SILENCE_MAX_MS, `queryToPaintMs=${silence.queryToPaintMs}`)
  check('silence: first painted screen is the 256 tier', silence.firstFrame.includes('\x1b[38;5;') && !silence.firstFrame.includes('\x1b[38;2;') && silence.firstScreen !== null)
  check('silence: Enter launches cleanly (exit 20)', silence.exitCode === 20, `exit=${silence.exitCode}`)
  check('silence: splash-action.json carries truecolor: pending (unanswered before exit)', silence.receipt?.truecolor === 'pending', JSON.stringify(silence.receipt))

  const lateEcho = await runArm({ reply: ECHO_REPLY, replyDelayMs: 80, enterDelayMs: 90 })
  check('late echo (80ms, waiting splash still up): writes request once, paints 256 first, upgrades receipt to truecolor: true, Enter exits 20', lateEcho.requestCount === 1 && lateEcho.requestBeforePaint && lateEcho.firstFrame.includes('\x1b[38;5;') && !lateEcho.firstFrame.includes('\x1b[38;2;') && !lateEcho.menuShownBeforeEnter && lateEcho.exitCode === 20 && lateEcho.receipt?.truecolor === true, `count=${lateEcho.requestCount} exit=${lateEcho.exitCode} receipt=${JSON.stringify(lateEcho.receipt)}`)

  const lateSplit = await runArm({ reply: ['\x1bP1$r0;48:2', '::1:2:3m\x1b\\', '\x1b[?62;22c'], replyDelayMs: 48, enterDelayMs: 90 })
  check('late split echo across 50ms bound: paints 256 first, never leaks keys, upgrades receipt to truecolor: true', lateSplit.requestCount === 1 && lateSplit.firstFrame.includes('\x1b[38;5;') && !lateSplit.menuShownBeforeEnter && lateSplit.exitCode === 20 && lateSplit.receipt?.truecolor === true, `count=${lateSplit.requestCount} exit=${lateSplit.exitCode} receipt=${JSON.stringify(lateSplit.receipt)}`)

  const lateSentinel = await runArm({ reply: SENTINEL_REPLY, replyDelayMs: 80, enterDelayMs: 90 })
  check('late sentinel alone (80ms, waiting splash still up): paints 256, settles receipt to truecolor: false', lateSentinel.requestCount === 1 && lateSentinel.firstFrame.includes('\x1b[38;5;') && lateSentinel.exitCode === 20 && lateSentinel.receipt?.truecolor === false, `count=${lateSentinel.requestCount} exit=${lateSentinel.exitCode} receipt=${JSON.stringify(lateSentinel.receipt)}`)

  const cinematicPending = await runArm({ reply: null, extraEnv: { MERCURY_FULLSCREEN: '1' }, sendEnter: false })
  check('cinematic silence: exits 0 cleanly with screen held and truecolor: pending', cinematicPending.requestCount === 1 && cinematicPending.exitCode === 0 && cinematicPending.receipt?.screen === 'held' && cinematicPending.receipt?.truecolor === 'pending', `count=${cinematicPending.requestCount} exit=${cinematicPending.exitCode} receipt=${JSON.stringify(cinematicPending.receipt)}`)

  const cinematicSplit = await runArm({ reply: ['\x1bP1$r0;48:2::1', ':2:3m\x1b\\\x1b[?62;22c'], replyDelayMs: 48, splitGapMs: 16, extraEnv: { MERCURY_FULLSCREEN: '1' }, sendEnter: false })
  check('cinematic split echo (16ms gap across 50ms bound): holds exit until tail arrives, settles receipt to truecolor: true, exits 0', cinematicSplit.requestCount === 1 && cinematicSplit.exitCode === 0 && cinematicSplit.receipt?.screen === 'held' && cinematicSplit.receipt?.truecolor === true, `count=${cinematicSplit.requestCount} exit=${cinematicSplit.exitCode} receipt=${JSON.stringify(cinematicSplit.receipt)}`)

  const cinematicDangling = await runArm({ reply: '\x1bP1$r0;48:2::1', replyDelayMs: 48, extraEnv: { MERCURY_FULLSCREEN: '1' }, sendEnter: false })
  check('cinematic unfinished reply head with no end: hold ends at bound and exits 0 with truecolor: pending', cinematicDangling.requestCount === 1 && cinematicDangling.exitCode === 0 && cinematicDangling.receipt?.screen === 'held' && cinematicDangling.receipt?.truecolor === 'pending', `count=${cinematicDangling.requestCount} exit=${cinematicDangling.exitCode} receipt=${JSON.stringify(cinematicDangling.receipt)}`)

  const xtermEcho = await runArm({ reply: ECHO_REPLY, extraEnv: { TERM: 'xterm' } })
  check('TERM=xterm + echo: asks once, paints 24-bit, writes truecolor: true', xtermEcho.requestCount === 1 && xtermEcho.requestBeforePaint && xtermEcho.firstFrame.includes('\x1b[38;2;') && !xtermEcho.firstFrame.includes('\x1b[38;5;') && xtermEcho.receipt?.truecolor === true && xtermEcho.exitCode === 20, `count=${xtermEcho.requestCount} exit=${xtermEcho.exitCode} receipt=${JSON.stringify(xtermEcho.receipt)}`)

  const xtermZero = await runArm({ reply: ZERO_M_REPLY, extraEnv: { TERM: 'xterm' } })
  check('TERM=xterm + 0m: asks once, paints basic 16 tier (no 38;5; or 38;2;), writes truecolor: false', xtermZero.requestCount === 1 && xtermZero.requestBeforePaint && !xtermZero.firstFrame.includes('\x1b[38;5;') && !xtermZero.firstFrame.includes('\x1b[38;2;') && /\x1b\[(?:3[0-7]|9[0-7])m/.test(xtermZero.firstFrame) && xtermZero.receipt?.truecolor === false && xtermZero.exitCode === 20, `count=${xtermZero.requestCount} exit=${xtermZero.exitCode} receipt=${JSON.stringify(xtermZero.receipt)}`)
}

section('§2 no-ask environments — no request written, no truecolor field in receipt')
{
  const cases: Array<{ label: string; env: Record<string, string>; sendEnter?: boolean }> = [
    { label: 'COLORTERM=truecolor', env: { COLORTERM: 'truecolor' } },
    { label: 'MERCURY_TRUECOLOR=0', env: { MERCURY_TRUECOLOR: '0' } },
    { label: 'MERCURY_TRUECOLOR=1', env: { MERCURY_TRUECOLOR: '1' } },
    { label: 'TERM=linux', env: { TERM: 'linux' } },
    { label: 'TERM_PROGRAM=Apple_Terminal', env: { TERM_PROGRAM: 'Apple_Terminal' } },
    { label: 'NO_COLOR=1', env: { NO_COLOR: '1' } },
    { label: 'FORCE_COLOR=2', env: { FORCE_COLOR: '2' } },
    { label: 'TMUX set', env: { TMUX: '/tmp/tmux-1000/default,1,0' } },
    { label: 'MERCURY_SPLASH_ONESHOT=1', env: { MERCURY_SPLASH_ONESHOT: '1' }, sendEnter: false },
  ]
  for (const c of cases) {
    const res = await runArm({ reply: ECHO_REPLY, extraEnv: c.env, sendEnter: c.sendEnter })
    check(`${c.label}: writes no readback request`, res.requestCount === 0 && !res.raw.includes('\x1bP$qm'), `count=${res.requestCount}`)
    if (c.sendEnter !== false) {
      check(`${c.label}: receipt omits truecolor field and Enter exits 20`, res.exitCode === 20 && res.receipt !== null && !Object.hasOwn(res.receipt, 'truecolor'), `exit=${res.exitCode} receipt=${JSON.stringify(res.receipt)}`)
    }
  }
}
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-splash-asks-once — ${passed}/${passed + failures} checks passed (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)

// ============================================================================
//  scripts/splash/ripple-probe.mjs — drain probe.
//
//  Fakes a TTY around the REAL splash and drives the terminal write-callback
//  drain per mode, so the ripple's bounded-drain law is provable without a
//  terminal (vendored from the Windows audit probe, SATURDAY
//  §5.2 / STATE.md HANDOFF 1; actions made scriptable for the prover).
//
//  usage: node ripple-probe.mjs <splash.mjs> <cols> <rows> <mode> <drainMs> <script>
//    mode  instant : write callback fires synchronously   (ideal terminal)
//          slow    : write callback fires after <drainMs> (slow ConPTY drain)
//          stall   : write callback NEVER fires after ↵   (wedged terminal)
//          stall0: write callback NEVER fires at all    (the
//                    fullscreen boot auto-runs the trace with no ↵ beat, so
//                    the wedge must be armable from the first frame)
//    script = comma list of action@ms offsets (from load), actions:
//          enter · ctrlc (raw ^C byte via stdin) · sigint · sigterm · resize
//
//  Report JSON → $PROBE_REPORT on every exit; a 12s backstop kills a splash
//  that never leaves on its own (exit 99, tag HARNESS-KILL) — the wedge
//  signature this probe exists to catch. NO_COLOR must be clear and TERM
//  truecolor-capable in the caller's env: NO_COLOR silently disables the
//  animation and false-greens every leg (audit method gotcha).
// ============================================================================
import { writeFileSync } from 'node:fs'

const [splashPath, colsArg, rowsArg, mode = 'instant', drainArg = '0', script = 'enter@700']
  = process.argv.slice(2)
const cols = Number(colsArg) || 120
const rows = Number(rowsArg) || 30
const drainMs = Number(drainArg) || 0

let bytes = 0
let writes = 0
let enterAt = null
let firstWriteAfterEnter = null
let lastWriteAfterEnter = null
let stalledWrites = 0
let cancelAt = null

const capture = (chunk, enc, cb) => {
  const done = typeof enc === 'function' ? enc : cb
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
  bytes += buf.length
  writes++
  if (enterAt !== null) {
    if (firstWriteAfterEnter === null) firstWriteAfterEnter = Date.now()
    lastWriteAfterEnter = Date.now()
  }
  if (typeof done === 'function') {
    if ((mode === 'stall' && enterAt !== null) || mode === 'stall0') { stalledWrites++ /* callback deliberately dropped */ }
    else if (mode === 'slow' && enterAt !== null) setTimeout(done, drainMs)
    else done()
  }
  return true
}

let liveCols = cols
let liveRows = rows
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdout, 'columns', { get: () => liveCols, configurable: true })
Object.defineProperty(process.stdout, 'rows', { get: () => liveRows, configurable: true })
process.stdout.write = capture
const noop = (...a) => { const cb = a[a.length - 1]; if (typeof cb === 'function') cb(); return true }
process.stdout.cursorTo = noop
process.stdout.clearLine = noop
process.stdout.clearScreenDown = noop

Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
process.stdin.setRawMode = () => process.stdin

const report = tag => {
  const now = Date.now()
  writeFileSync(process.env.PROBE_REPORT, JSON.stringify({
    tag, mode, cols, rows, drainMs, script, bytes, writes,
    enterAt, cancelAt, reportAt: now,
    enterToReportMs: enterAt ? now - enterAt : null,
    cancelToReportMs: cancelAt ? now - cancelAt : null,
    rippleWallMs: enterAt && lastWriteAfterEnter ? lastWriteAfterEnter - enterAt : null,
    stalledWrites,
  }, null, 2))
}

process.on('exit', c => { report('exit-' + c); process.stderr.write(`PROBE exited code=${c}\n`) })

await import('file://' + splashPath.replace(/\\/g, '/'))

for (const step of script.split(',')) {
  const [action, atRaw] = step.split('@')
  const at = Number(atRaw) || 0
  setTimeout(() => {
    process.stderr.write(`PROBE action ${action} at +${at}ms\n`)
    if (action === 'enter') {
      enterAt = Date.now()
      process.stdin.emit('data', Buffer.from('\r'))
    } else if (action === 'ctrlc') {
      cancelAt = Date.now()
      process.stdin.emit('data', Buffer.from('\x03'))
    } else if (action === 'sigint') {
      cancelAt = Date.now()
      process.emit('SIGINT')
    } else if (action === 'sigterm') {
      cancelAt = Date.now()
      process.emit('SIGTERM')
    } else if (action === 'resize') {
      liveCols = Math.max(40, cols - 20)
      liveRows = Math.max(12, rows - 6)
      process.stdout.emit('resize')
    }
  }, at)
}

// harness backstop — the splash is supposed to leave on its own
setTimeout(() => {
  report('HARNESS-KILL-no-self-exit')
  process.stderr.write('PROBE HARNESS KILL — splash never exited on its own\n')
  process.exit(99)
}, 12000)

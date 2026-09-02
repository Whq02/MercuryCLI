// ============================================================================
//  scripts/navigation/measure-baseline.ts — PRE- baseline measurements on
//  the 1k fixture.
//
//  Real binary, real PTY (scripts/navigation/arena.ts: dist/mercury.mjs booted
//  `--resume` onto the staged 1,011-line fixture), timestamps from the PTY
//  side (ptydrive send/resize fire epochs vs output-chunk arrival epochs) +
//  the app-side INK_WRITE_TEE frame log. Wall-clock legs run ≥5 arenas and
//  pool per-event samples into honest p50/p95 (never single-shot claims).
//
//  Legs (--legs a,b,…; default all):
//    load      resume boot → 1k transcript tail visible (pyte bisect)
//    stream    live streamed tail on top of the resumed 1k (ack + FIN)
//    echo      idle composer input-echo p95 under the 1k fixture
//    nav       arrow-key selection latency on the slash-suggestion list
//    scroll    PageUp/PageDown transcript paint latency
//    overlay   /model open + Esc close latency
//    resize    slow-step + rapid-drag SIGWINCH: latency/settle/bytes per step
//    heldarrow 50-repeat arrow burst + 30-repeat PageUp burst: trailing
//              render backlog after release
//
//  Usage: ~/.bun/bin/bun scripts/navigation/measure-baseline.ts \
//           [--legs echo,nav] [--runs 5] [--json out.json]
//  Re-runnable by design: the follow-up pass re-runs the same command for
//  before/after receipts. Every arena is cleaned up before exit.
// ============================================================================

import { writeFileSync } from 'node:fs'
import { runCompassArena, grabScreens, pct, firstOutAfter, settleAfter, type CompassRun } from './arena.ts'
import { streamedTailTurn, TAIL_SENTINEL, STREAM_FIN } from './fixture1k.ts'

const COLS = 120
const ROWS = 40
const SETTLE = 9000 // ms after spawn before the first interaction (1k resume load)

const DOWN = '\\x1b[B'
const UP = '\\x1b[A'
const PGUP = '\\x1b[5~'
const PGDN = '\\x1b[6~'
const ESC = '\\x1b'
const ENTER = '\\r'

// ── plumbing ────────────────────────────────────────────────────────────────

function typeSends(startMs: number, text: string, gapMs: number): string[] {
  return [...text].map((ch, i) => `${startMs + i * gapMs}:${ch}`)
}

/** ptydrive process-start epoch, derived from any logged send/resize (fire
 *  epoch − scheduled offset; fires land within ~1ms of schedule). */
function ptyT0(run: CompassRun): number {
  const s = run.sends[0]
  if (s) return s.sent - s.atMs
  const r = run.resizes[0]
  if (r) return r.resized - r.atMs
  return run.outs[0]?.ts ?? 0
}

/** send→first-output latencies for the sends whose payload matches `b64of`,
 *  each bounded by the NEXT send (no cross-attribution) + tailCeilingMs. */
function keyLatencies(
  run: CompassRun,
  match: (b64: string) => boolean,
  tailCeilingMs = 1500,
): { lat: number[]; noPaint: number } {
  const lat: number[] = []
  let noPaint = 0
  const sends = run.sends
  for (let i = 0; i < sends.length; i++) {
    if (!match(sends[i]!.b64)) continue
    const ceiling = Math.min(
      sends[i + 1]?.sent ?? Infinity,
      sends[i]!.sent + tailCeilingMs,
    )
    const o = firstOutAfter(run, sends[i]!.sent, ceiling)
    if (o) lat.push(o.ts - sends[i]!.sent)
    else noPaint++
  }
  return { lat, noPaint }
}

const b64 = (s: string): string => Buffer.from(s, 'latin1').toString('base64')
const B64_DOWN = b64('\x1b[B')
const B64_UP = b64('\x1b[A')
const B64_PGUP = b64('\x1b[5~')
const B64_PGDN = b64('\x1b[6~')
const B64_ENTER = b64('\r')
const B64_ESC = b64('\x1b')

function summarize(lat: number[]): { n: number; p50: number; p95: number; max: number } {
  return {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    max: lat.length ? Math.max(...lat) : -1,
  }
}

// ── legs ────────────────────────────────────────────────────────────────────

async function legLoad(): Promise<Record<string, unknown>> {
  const run = await runCompassArena({ sends: [], seconds: 15 })
  try {
    if (run.outs.length === 0) return { failed: 'no PTY output at all', driverOut: run.driverOut.slice(-500) }
    const offsets: number[] = []
    for (let t = 250; t <= 12_000; t += 250) offsets.push(t)
    const screens = grabScreens(run, COLS, ROWS, [...offsets, -1])
    const final = screens.find(s => s.atMs === -1)!
    const tailVisible = (rows: string[]): boolean => rows.some(r => r.includes('FIXTURE-TAIL'))
    if (!tailVisible(final.rows)) {
      return {
        failed: `tail sentinel "${TAIL_SENTINEL}" NOT on the final screen — fixture did not load`,
        finalTail: final.rows.slice(-14),
        driverOut: run.driverOut.slice(-500),
      }
    }
    const first = screens.find(s => s.atMs >= 0 && tailVisible(s.rows))
    const bootBytes = run.outs.reduce((a, o) => a + o.bytes, 0)
    return {
      loaded: true,
      // offset is relative to the FIRST output chunk (screengrab semantics),
      // at 250ms bisect granularity
      tailVisibleAtMsAfterFirstPaint: first?.atMs ?? -1,
      bootBytes,
      bootChunks: run.outs.length,
    }
  } finally {
    run.cleanup()
  }
}

async function legStream(): Promise<Record<string, unknown>> {
  const sends = [...typeSends(SETTLE, 'go', 60), `${SETTLE + 400}:${ENTER}`]
  const run = await runCompassArena({ sends, seconds: 18, turns: [streamedTailTurn()] })
  try {
    const enter = run.sends.find(s => s.b64 === B64_ENTER)
    if (!enter) return { failed: 'enter send missing from drive log' }
    const ack = firstOutAfter(run, enter.sent, enter.sent + 3000)
    const final = grabScreens(run, COLS, ROWS, [-1]).find(s => s.atMs === -1)!
    const finVisible = final.rows.some(r => r.includes(STREAM_FIN))
    return {
      submitAckMs: ack ? ack.ts - enter.sent : null,
      streamedFinVisible: finVisible,
      ...(finVisible ? {} : { finalTail: final.rows.slice(-14) }),
    }
  } finally {
    run.cleanup()
  }
}

const ECHO_TEXT = 'the quick brown fox measures compass echo latency 42'

async function legEcho(runs: number): Promise<Record<string, unknown>> {
  const lat: number[] = []
  let noPaint = 0
  let idleChunks = 0
  let idleBytes = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({
      sends: typeSends(SETTLE + 4500, ECHO_TEXT, 85),
      seconds: 21,
    })
    try {
      const t0 = ptyT0(run)
      for (const o of run.outs) {
        if (o.ts > t0 + SETTLE && o.ts <= t0 + SETTLE + 4000) {
          idleChunks++
          idleBytes += o.bytes
        }
      }
      const k = keyLatencies(run, () => true, 1000)
      lat.push(...k.lat)
      noPaint += k.noPaint
    } finally {
      run.cleanup()
    }
  }
  return {
    runs,
    charsPerRun: ECHO_TEXT.length,
    echo: summarize(lat),
    noPaintKeys: noPaint,
    idleWindowPerRunMs: 4000,
    idleChunksTotal: idleChunks,
    idleBytesTotal: idleBytes,
  }
}

async function legNav(runs: number): Promise<Record<string, unknown>> {
  const sends: string[] = [`${SETTLE}:/`]
  for (let k = 0; k < 20; k++) sends.push(`${SETTLE + 800 + k * 300}:${DOWN}`)
  for (let k = 0; k < 5; k++) sends.push(`${SETTLE + 7100 + k * 300}:${UP}`)
  sends.push(`${SETTLE + 8900}:${ESC}`)
  const down: number[] = []
  const up: number[] = []
  let noPaint = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends, seconds: 21 })
    try {
      const d = keyLatencies(run, s => s === B64_DOWN)
      const u = keyLatencies(run, s => s === B64_UP)
      down.push(...d.lat)
      up.push(...u.lat)
      noPaint += d.noPaint + u.noPaint
    } finally {
      run.cleanup()
    }
  }
  return {
    runs,
    surface: 'slash-suggestion list over the 1k transcript',
    arrowDown: summarize(down),
    arrowUp: summarize(up),
    pooled: summarize([...down, ...up]),
    noPaintKeys: noPaint,
  }
}

async function legScroll(runs: number): Promise<Record<string, unknown>> {
  const sends: string[] = []
  for (let k = 0; k < 12; k++) sends.push(`${SETTLE + k * 400}:${PGUP}`)
  for (let k = 0; k < 12; k++) sends.push(`${SETTLE + 5200 + k * 400}:${PGDN}`)
  const pgup: number[] = []
  const pgdn: number[] = []
  let upNoPaint = 0
  let dnNoPaint = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends, seconds: 22 })
    try {
      const u = keyLatencies(run, s => s === B64_PGUP)
      const d = keyLatencies(run, s => s === B64_PGDN)
      pgup.push(...u.lat)
      pgdn.push(...d.lat)
      upNoPaint += u.noPaint
      dnNoPaint += d.noPaint
    } finally {
      run.cleanup()
    }
  }
  return {
    runs,
    pageUp: { ...summarize(pgup), noPaintKeys: upNoPaint },
    pageDown: { ...summarize(pgdn), noPaintKeys: dnNoPaint },
    pooled: summarize([...pgup, ...pgdn]),
  }
}

async function legOverlay(runs: number): Promise<Record<string, unknown>> {
  const ITERS = 5
  const sends: string[] = []
  for (let k = 0; k < ITERS; k++) {
    const base = SETTLE + k * 3000
    sends.push(...typeSends(base, '/model', 40))
    sends.push(`${base + 700}:${ENTER}`)
    sends.push(`${base + 2200}:${ESC}`)
  }
  const open: number[] = []
  const close: number[] = []
  const openSettleMs: number[] = []
  let openNoPaint = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends, seconds: 27 })
    try {
      for (const s of run.sends) {
        if (s.b64 === B64_ENTER) {
          const o = firstOutAfter(run, s.sent, s.sent + 1400)
          if (o) {
            open.push(o.ts - s.sent)
            const st = settleAfter(run, s.sent, 350, 1400)
            if (st) openSettleMs.push(st.settleTs - s.sent)
          } else openNoPaint++
        } else if (s.b64 === B64_ESC) {
          const o = firstOutAfter(run, s.sent, s.sent + 700)
          if (o) close.push(o.ts - s.sent)
        }
      }
    } finally {
      run.cleanup()
    }
  }
  return {
    runs,
    itersPerRun: ITERS,
    overlay: '/model picker',
    open: summarize(open),
    openSettle: summarize(openSettleMs),
    close: summarize(close),
    openNoPaint,
  }
}

async function legResize(runs: number): Promise<Record<string, unknown>> {
  const slow: [number, number][] = [
    [110, 40], [100, 40], [88, 40], [100, 40], [110, 40], [120, 40],
  ]
  const rapid: [number, number][] = [
    [112, 40], [104, 40], [96, 40], [110, 40], [120, 40],
  ]
  const resizes: string[] = []
  slow.forEach(([c, rw], k) => resizes.push(`${SETTLE + k * 1000}:${c}:${rw}`))
  rapid.forEach(([c, rw], k) => resizes.push(`${SETTLE + 8000 + k * 120}:${c}:${rw}`))

  const firstPaint: number[] = []
  const settleDur: number[] = []
  const stepBytes: number[] = []
  const stepChunks: number[] = []
  const rapidTrail: number[] = []
  const rapidBytes: number[] = []
  const rapidFrames: number[] = []
  let noPaintSteps = 0
  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends: [], resizes, seconds: 24 })
    try {
      const t0 = ptyT0(run)
      const slowFires = run.resizes.filter(z => z.atMs < SETTLE + 7000)
      const rapidFires = run.resizes.filter(z => z.atMs >= SETTLE + 7000)
      for (const z of slowFires) {
        const o = firstOutAfter(run, z.resized, z.resized + 950)
        if (!o) {
          noPaintSteps++
          continue
        }
        firstPaint.push(o.ts - z.resized)
        const st = settleAfter(run, z.resized, 350, 950)
        if (st) {
          settleDur.push(st.settleTs - z.resized)
          stepBytes.push(st.bytes)
          stepChunks.push(st.chunks)
        }
      }
      if (rapidFires.length > 0) {
        const last = rapidFires[rapidFires.length - 1]!
        const st = settleAfter(run, last.resized, 400, 4000)
        rapidTrail.push(st ? st.settleTs - last.resized : -1)
        const w0 = rapidFires[0]!.resized
        const w1 = last.resized + (st ? st.settleTs - last.resized : 0) + 1
        rapidBytes.push(run.outs.filter(o => o.ts > w0 && o.ts <= w1).reduce((a, o) => a + o.bytes, 0))
        rapidFrames.push(run.teeLines.filter(t => t.ts > w0 && t.ts <= w1).length)
      }
      void t0
    } finally {
      run.cleanup()
    }
  }
  return {
    runs,
    slowStepsPerRun: slow.length,
    slowStep: {
      firstPaint: summarize(firstPaint),
      settle: summarize(settleDur),
      bytes: summarize(stepBytes),
      chunks: summarize(stepChunks),
      noPaintSteps,
    },
    rapidDrag: {
      stepsPerRun: rapid.length,
      gapMs: 120,
      settleAfterLast: summarize(rapidTrail),
      bytes: summarize(rapidBytes),
      appFrames: summarize(rapidFrames),
    },
  }
}

async function legHeldArrow(runs: number): Promise<Record<string, unknown>> {
  const sends: string[] = [`${SETTLE}:/`]
  for (let k = 0; k < 50; k++) sends.push(`${SETTLE + 800 + k * 20}:${DOWN}`)
  sends.push(`${SETTLE + 4200}:${ESC}`)
  for (let k = 0; k < 30; k++) sends.push(`${SETTLE + 5200 + k * 30}:${PGUP}`)

  type Burst = { trailingFrames: number[]; trailingSpanMs: number[]; burstFrames: number[]; trailingBytes: number[] }
  const arrow: Burst = { trailingFrames: [], trailingSpanMs: [], burstFrames: [], trailingBytes: [] }
  const pageup: Burst = { trailingFrames: [], trailingSpanMs: [], burstFrames: [], trailingBytes: [] }

  const analyze = (run: CompassRun, matchB64: string, into: Burst): void => {
    const burst = run.sends.filter(s => s.b64 === matchB64)
    if (burst.length === 0) return
    const first = burst[0]!.sent
    const last = burst[burst.length - 1]!.sent
    const trail = run.teeLines.filter(t => t.ts > last && t.ts <= last + 2500)
    into.trailingFrames.push(trail.length)
    into.trailingSpanMs.push(trail.length ? trail[trail.length - 1]!.ts - last : 0)
    into.burstFrames.push(run.teeLines.filter(t => t.ts >= first && t.ts <= last).length)
    into.trailingBytes.push(
      run.outs.filter(o => o.ts > last && o.ts <= last + 2500).reduce((a, o) => a + o.bytes, 0),
    )
  }

  for (let r = 0; r < runs; r++) {
    const run = await runCompassArena({ sends, seconds: 20 })
    try {
      analyze(run, B64_DOWN, arrow)
      analyze(run, B64_PGUP, pageup)
    } finally {
      run.cleanup()
    }
  }
  const report = (b: Burst, n: number, gap: number): Record<string, unknown> => ({
    keys: n,
    keyGapMs: gap,
    burstFrames: summarize(b.burstFrames),
    trailingFramesAfterRelease: summarize(b.trailingFrames),
    trailingSpanMs: summarize(b.trailingSpanMs),
    trailingBytes: summarize(b.trailingBytes),
  })
  return {
    runs,
    arrowBurstOnList: report(arrow, 50, 20),
    pageUpBurstOnTranscript: report(pageup, 30, 30),
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const ALL_LEGS = ['load', 'stream', 'echo', 'nav', 'scroll', 'overlay', 'resize', 'heldarrow'] as const
type Leg = (typeof ALL_LEGS)[number]

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const legsArg = args.includes('--legs') ? args[args.indexOf('--legs') + 1]! : ALL_LEGS.join(',')
  const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 5
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1]! : null
  const legs = legsArg.split(',').map(s => s.trim()) as Leg[]
  for (const l of legs) {
    if (!ALL_LEGS.includes(l)) {
      console.error(`unknown leg: ${l} (valid: ${ALL_LEGS.join(', ')})`)
      process.exit(2)
    }
  }

  const results: Record<string, unknown> = {
    fixture: '1k resumed transcript (scripts/navigation/fixture1k.ts)',
    cols: COLS,
    rows: ROWS,
    settleMs: SETTLE,
    runsDefault: runs,
  }
  for (const leg of legs) {
    process.stderr.write(`[compass-baseline] leg ${leg}…\n`)
    const t = Date.now()
    try {
      results[leg] =
        leg === 'load' ? await legLoad()
        : leg === 'stream' ? await legStream()
        : leg === 'echo' ? await legEcho(runs)
        : leg === 'nav' ? await legNav(runs)
        : leg === 'scroll' ? await legScroll(runs)
        : leg === 'overlay' ? await legOverlay(runs)
        : leg === 'resize' ? await legResize(runs)
        : await legHeldArrow(runs)
    } catch (e) {
      results[leg] = { failed: String(e) }
    }
    process.stderr.write(`[compass-baseline] leg ${leg} done in ${((Date.now() - t) / 1000).toFixed(1)}s\n`)
  }

  const payload = JSON.stringify(results, null, 2)
  console.log(payload)
  if (jsonOut) writeFileSync(jsonOut, payload + '\n')
}

await main()

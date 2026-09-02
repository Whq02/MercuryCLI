#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/measure-render-traffic.ts — the render-TRAFFIC oracle for the
//  REPL smoothness pass: counts real terminal WRITES per second
//  produced by the in-turn animation surfaces, in a real PTY, on the
//  production write path.
//
//  Method (baseline-first, per the inline-writer method card): each SCENE
//  mounts the actual components standalone under a real Ink render inside
//  ptyrun.py's PTY (isTTY=true → 16ms throttle + fd writeAllSync — NOT the
//  test immediate-render or the non-TTY full-frame branch), with
//  INK_WRITE_TEE recording one JSON line per writeDiffToTerminal call.
//  The parent then reports writes/s + bytes/s + inter-write gaps.
//
//  Scenes:
//    idle-static     — a static tree (methodology control: ~0 writes/s)
//    turn-thinking   — SpinnerAnimationRow in 'thinking' (shimmer wave)
//    turn-tools      — 3× breathing ToolUseLoader (the ◐ FAINT→TEAL lerp)
//    turn-responding — SpinnerAnimationRow in 'responding' + a ref-mutated
//                      response length climbing like a live stream
//    scroll-fullwidth / scroll-cockpit — the SAME tall ScrollBox driven ±3
//                      rows @20 steps/s; the cockpit variant sits beside a
//                      24-col rail inside a border (spansFullWidth=false),
//                      so the pair measures the partial-width damage path
//                      (the shiftRect ratchet)
//    stream-deckstrip / stream-cockpit — a sticky ScrollBox appending one
//                      styled line per 50ms (full-width @90 cols vs the
//                      cockpit wrap @120) — the sticky-follow stream path
//
//  Run:  ~/.bun/bin/bun run scripts/ui/measure-render-traffic.ts [scene…]
//  Budget mode (proof): MEASURE_BUDGET=1 asserts per-scene writes/s ceilings
//  so a regression that re-storms the animation path fails the ui suite.
// ============================================================================

// Fork-sim so the build stamp is true when run from src (child side).
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const BUN = process.execPath

// ── child: mount the scene and animate until the runner kills us ────────────
if (process.env.MEASURE_CHILD) {
  const scene = process.env.MEASURE_SCENE ?? 'turn-thinking'
  const cols = Number(process.env.MEASURE_COLS ?? '120')
  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: unknown) => Promise<unknown>
    Box: unknown
    Text: unknown
  }
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  // Production config gate: the child runs OUTSIDE test mode (test mode
  // bypasses the 16ms render throttle — reconciler.ts:292 — which would
  // invalidate the measurement), so open configs the way main() does.
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const h = React.createElement as (...a: unknown[]) => unknown
  const ref = <T,>(v: T) => ({ current: v })
  const paneScene = scene.startsWith('scroll-') || scene.startsWith('stream-')

  // Steady transcript-like filler so the compose walks realistic content.
  // Pane scenes keep it short — the ScrollBox viewport is the subject there.
  const filler = Array.from({ length: paneScene ? 6 : 18 }, (_, i) =>
    h(Text as never, { key: `f${i}` }, `transcript line ${i} — steady prose content that does not change`),
  )

  // The cockpit wrap: a fixed 24-col rail beside a bordered flexGrow center —
  // the minimal shape that makes the inner ScrollBox fail spansFullWidth,
  // exactly the helm-home geometry the partial-width scroll path must serve.
  const cockpitWrap = (inner: unknown): unknown =>
    h(
      Box as never,
      { flexDirection: 'row', width: '100%' },
      h(
        Box as never,
        { width: 24, flexShrink: 0, flexDirection: 'column' },
        ...Array.from({ length: 8 }, (_, i) => h(Text as never, { key: `rail${i}` }, `rail row ${i} · steady`)),
      ),
      h(Box as never, { borderStyle: 'round', flexGrow: 1 }, inner),
    )

  let live: unknown = null
  if (scene === 'idle-static') {
    live = h(Text as never, {}, '● ready')
  } else if (scene === 'scroll-fullwidth' || scene === 'scroll-cockpit') {
    const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.js')
    type Handle = {
      scrollBy: (dy: number) => void
      getScrollTop: () => number
      getScrollHeight: () => number
      getPendingDelta: () => number
      getViewportHeight: () => number
    }
    // Rows must be VISUALLY DISTINCT across most of their width — the cell
    // diff only emits changed cells, so self-similar rows (only a digit
    // differing) would under-count the slow path's real wire cost by ~20×.
    const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    const rowText = (i: number) =>
      `${String(i).padStart(3, '0')} ${W[i % 12]} ${W[(i * 5 + 3) % 12]} ${'▪'.repeat(1 + ((i * 7) % 40))} ${W[(i * 11 + 7) % 12]} ${String((i * 2654435761) >>> 20)}`
    const rows = Array.from({ length: 220 }, (_, i) =>
      h(Text as never, { key: `r${i}`, ...(i % 5 === 0 ? { color: 'cyan' } : {}) }, rowText(i)),
    )
    // Oscillating driver: ±3 rows every 50ms (20 steps/s), direction flip
    // every 40 ticks so scrollTop stays in range — the SAME driver for both
    // variants, so bytes-per-step is directly comparable across the pair.
    const Scroller = () => {
      const handle = React.useRef<Handle | null>(null)
      React.useEffect(() => {
        let dir = 1
        let tick = 0
        const dbg = process.env.MEASURE_DEBUG
        if (dbg) require('node:fs').appendFileSync(dbg, `mount handle=${handle.current ? 'set' : 'null'}\n`)
        const t = setInterval(() => {
          tick += 1
          if (tick % 40 === 0) dir = -dir
          if (dbg && tick <= 6) {
            const c = handle.current
            require('node:fs').appendFileSync(
              dbg,
              `tick ${tick} top=${c?.getScrollTop()} pend=${c?.getPendingDelta()} sh=${c?.getScrollHeight()} vh=${c?.getViewportHeight()}\n`,
            )
          }
          handle.current?.scrollBy(dir * 3)
        }, 50)
        return () => clearInterval(t)
      }, [])
      return h(ScrollBox as never, { ref: handle, flexDirection: 'column', height: 16, width: '100%' }, ...rows)
    }
    live = scene === 'scroll-cockpit' ? cockpitWrap(h(Scroller as never, {})) : h(Scroller as never, {})
  } else if (scene === 'stream-cockpit' || scene === 'stream-deckstrip') {
    const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.js')
    const Streamer = () => {
      const [count, setCount] = React.useState(1)
      React.useEffect(() => {
        const t = setInterval(() => setCount(c => c + 1), 50)
        return () => clearInterval(t)
      }, [])
      return h(
        ScrollBox as never,
        { stickyScroll: true, flexDirection: 'column', height: 16, width: '100%' },
        ...Array.from({ length: count }, (_, i) =>
          h(
            Text as never,
            { key: `s${i}`, ...(i % 4 === 0 ? { color: 'cyan' } : {}) },
            `${String(i).padStart(3, '0')} streamed ${'▪'.repeat(1 + ((i * 7) % 40))} ${String((i * 2654435761) >>> 20)}`,
          ),
        ),
      )
    }
    live = scene === 'stream-cockpit' ? cockpitWrap(h(Streamer as never, {})) : h(Streamer as never, {})
  } else if (scene === 'turn-tools') {
    const { ToolUseLoader } = await import('../../src/components/ToolUseLoader.js')
    live = h(
      Box as never,
      { flexDirection: 'column' },
      ...[0, 1, 2].map(i =>
        h(
          Box as never,
          { key: `t${i}`, flexDirection: 'row' },
          h(ToolUseLoader as never, {
            isError: false,
            isUnresolved: true,
            shouldAnimate: true,
          }),
          h(Text as never, {}, `Bash(sleep ${i + 1}) — running`),
        ),
      ),
    )
  } else {
    const { SpinnerAnimationRow } = await import('../../src/components/Spinner/SpinnerAnimationRow.js')
    const responseLengthRef = ref(0)
    if (scene === 'turn-responding') {
      // Simulate a live stream: mutate the ref like query.ts's onStreamingText
      // accounting does (no React state — production shape).
      setInterval(() => {
        responseLengthRef.current += 120
      }, 100)
    }
    live = h(SpinnerAnimationRow as never, {
      mode: scene === 'turn-responding' ? 'responding' : 'thinking',
      reducedMotion: false,
      hasActiveTools: scene !== 'turn-responding',
      activeToolCount: 0,
      responseLengthRef,
      message: 'Contemplating',
      messageColor: 'claude',
      shimmerColor: 'claudeShimmer',
      overrideColor: null,
      loadingStartTimeRef: ref(Date.now()),
      totalPausedMsRef: ref(0),
      pauseStartTimeRef: ref<number | null>(null),
      spinnerSuffix: null,
      verbose: true,
      columns: cols,
      hasRunningTeammates: false,
      teammateTokens: 0,
      foregroundedTeammate: undefined,
      leaderIsIdle: false,
      thinkingStatus: scene === 'turn-responding' ? null : ('thinking' as const),
      effortSuffix: '',
    })
  }

  // Pane scenes run inside AlternateScreen — the constrained-height root is
  // what arms the production scroll/damage machinery (ScrollBox clipping, the
  // DECSTBM fast path, composed-frame forensics). The inline writer never
  // scrolls a pane, so measuring these scenes outside alt-screen measures
  // nothing. mouseTracking off: no pointer in the PTY.
  const tree = h(Box as never, { flexDirection: 'column' }, ...filler, live)
  let mounted = tree
  if (paneScene) {
    const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.js')
    mounted = h(AlternateScreen as never, { mouseTracking: false }, tree)
  }
  void render(h(AppStateProvider as never, {}, mounted))
  // Keep alive until ptyrun kills us; the animation clock keeps the loop busy.
  setInterval(() => {}, 1 << 30)
} else {
  // ── parent: run each scene in a PTY, parse the tee, report ────────────────
  type TeeLine = { ts: number; len: number }
  const SCENES = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const scenes = SCENES.length
    ? SCENES
    : ['idle-static', 'turn-thinking', 'turn-tools', 'turn-responding']
  const SECONDS = Number(process.env.MEASURE_SECONDS ?? '12')
  const budget = process.env.MEASURE_BUDGET === '1'
  // Per-scene writes/s ceilings (budget mode). Set from the post-fix steady
  // state with ~40% headroom — a
  // re-storm (raw-tick continuous waves: 15.7 / 11.5 / 12.8 pre-fix) blows
  // straight past these while honest machine variance stays under.
  const CEILINGS: Record<string, number> = {
    'idle-static': 1.0,
    'turn-thinking': 9,
    'turn-tools': 9,
    'turn-responding': 13,
    // Pane scenes drive 20 steps/s; steady writes measure ~18.6/s (one write
    // per driver step, throttle-coalesced). 26 = the house ~40% headroom —
    // a drain gone re-entrant (multiple writes per step) blows past it.
    'scroll-fullwidth': 26,
    'scroll-cockpit': 26,
    'stream-deckstrip': 26,
    'stream-cockpit': 26,
  }
  // Per-scene PTY width (default 120). stream-deckstrip is the <100-col
  // deck-strip home — full-width pane, the fast-path control for its
  // cockpit twin.
  const SCENE_COLS: Record<string, number> = { 'stream-deckstrip': 90 }
  // Driver cadence for the pane scenes (steps/s) — turns bytes/s into the
  // machine-independent bytes-per-step the Step-5 ratio ratchet asserts.
  const STEPPED: Record<string, number> = {
    'scroll-fullwidth': 20,
    'scroll-cockpit': 20,
    'stream-deckstrip': 20,
    'stream-cockpit': 20,
  }

  const results: Record<string, { writesPerSec: number; bytesPerSec: number; bytesPerStep?: number; writes: number; p50GapMs: number; maxGapMs: number }> = {}
  let failed = false
  for (const scene of scenes) {
    const dir = mkdtempSync(join(tmpdir(), 'measure-rt-'))
    const tee = join(dir, 'tee.jsonl')
    const cols = SCENE_COLS[scene] ?? 120
    const r = spawnSync(
      'python3',
      [join(HERE, 'ptyrun.py'), '--cols', String(cols), '--rows', '40', '--seconds', String(SECONDS), '--', BUN, 'run', SELF],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TERM: 'xterm-256color',
          // The dumb PTY answers no DECRQM probe, so the sniff would report
          // no DEC 2026 → decstbmSafe=false → the DECSTBM fast path never
          // engages and fullwidth measures identical to cockpit. Force it:
          // the operator terminals (ghostty/iTerm2/kitty class) all have it.
          MERCURY_FORCE_SYNC_OUTPUT: '1',
          MEASURE_CHILD: '1',
          MEASURE_SCENE: scene,
          MEASURE_COLS: String(cols),
          INK_WRITE_TEE: tee,
          // Hermetic homes — never touch the operator's real config/daemon.
          MERCURY_CONFIG_DIR: join(dir, 'config'),
          MERCURY_DAEMON_DIR: join(dir, 'daemon'),
          MERCURY_TEAMS_DIR: join(dir, 'teams'),
        },
        encoding: 'utf8',
        timeout: (SECONDS + 30) * 1000,
      },
    )
    let lines: TeeLine[] = []
    try {
      lines = readFileSync(tee, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as TeeLine)
    } catch {
      /* no writes at all is a valid (idle) result */
    }
    rmSync(dir, { recursive: true, force: true })
    if (r.status !== 0 && lines.length === 0) {
      console.error(`✗ ${scene}: runner failed (status ${r.status})\n${r.stderr ?? ''}`)
      failed = true
      continue
    }
    // Skip the boot burst: measure from 2s after the first write.
    const t0 = (lines[0]?.ts ?? 0) + 2000
    const steady = lines.filter(l => l.ts >= t0)
    const span = steady.length > 1 ? (steady.at(-1)!.ts - steady[0]!.ts) / 1000 : SECONDS - 2
    const writesPerSec = steady.length / Math.max(span, 0.001)
    const bytesPerSec = steady.reduce((a, l) => a + l.len, 0) / Math.max(span, 0.001)
    const gaps = steady.slice(1).map((l, i) => l.ts - steady[i]!.ts).sort((a, b) => a - b)
    const p50GapMs = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0
    const maxGapMs = gaps.length ? gaps.at(-1)! : 0
    const stepsPerSec = STEPPED[scene]
    results[scene] = {
      writesPerSec: Math.round(writesPerSec * 10) / 10,
      bytesPerSec: Math.round(bytesPerSec),
      ...(stepsPerSec ? { bytesPerStep: Math.round(bytesPerSec / stepsPerSec) } : {}),
      writes: steady.length,
      p50GapMs,
      maxGapMs,
    }
    const ceiling = CEILINGS[scene]
    const over = budget && ceiling !== undefined && writesPerSec > ceiling
    if (over) failed = true
    console.log(
      `${over ? '✗' : '·'} ${scene.padEnd(16)} ${results[scene]!.writesPerSec.toString().padStart(6)} writes/s  ${String(results[scene]!.bytesPerSec).padStart(8)} B/s${
        stepsPerSec ? `  ${String(results[scene]!.bytesPerStep).padStart(7)} B/step` : ''
      }  p50 gap ${p50GapMs}ms  max ${maxGapMs}ms${
        budget && ceiling !== undefined ? `  (ceiling ${ceiling}/s)` : ''
      }`,
    )
  }
  console.log(JSON.stringify(results))
  if (budget) {
    if (failed) {
      console.error('✗ measure-render-traffic: a scene exceeded its writes/s ceiling')
      process.exit(1)
    }
    console.log('✓ measure-render-traffic: all scenes within budget')
  }
  process.exit(failed ? 1 : 0)
}

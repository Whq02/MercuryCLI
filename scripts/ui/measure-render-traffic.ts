#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
}

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const BUN = process.execPath

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
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const h = React.createElement as (...a: unknown[]) => unknown
  const ref = <T,>(v: T) => ({ current: v })
  const paneScene = scene.startsWith('scroll-') || scene.startsWith('stream-')

  const filler = Array.from({ length: paneScene ? 6 : 18 }, (_, i) =>
    h(Text as never, { key: `f${i}` }, `transcript line ${i} — steady prose content that does not change`),
  )

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
    const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    const rowText = (i: number) =>
      `${String(i).padStart(3, '0')} ${W[i % 12]} ${W[(i * 5 + 3) % 12]} ${'▪'.repeat(1 + ((i * 7) % 40))} ${W[(i * 11 + 7) % 12]} ${String((i * 2654435761) >>> 20)}`
    const rows = Array.from({ length: 220 }, (_, i) =>
      h(Text as never, { key: `r${i}`, ...(i % 5 === 0 ? { color: 'cyan' } : {}) }, rowText(i)),
    )
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

  const tree = h(Box as never, { flexDirection: 'column' }, ...filler, live)
  let mounted = tree
  if (paneScene) {
    const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.js')
    mounted = h(AlternateScreen as never, { mouseTracking: false }, tree)
  }
  void render(h(AppStateProvider as never, {}, mounted))
  setInterval(() => {}, 1 << 30)
} else {
  type TeeLine = { ts: number; len: number }
  const SCENES = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const scenes = SCENES.length
    ? SCENES
    : ['idle-static', 'turn-thinking', 'turn-tools', 'turn-responding']
  const SECONDS = Number(process.env.MEASURE_SECONDS ?? '12')
  const budget = process.env.MEASURE_BUDGET === '1'
  const CEILINGS: Record<string, number> = {
    'idle-static': 1.0,
    'turn-thinking': 9,
    'turn-tools': 9,
    'turn-responding': 13,
    'scroll-fullwidth': 26,
    'scroll-cockpit': 26,
    'stream-deckstrip': 26,
    'stream-cockpit': 26,
  }
  const SCENE_COLS: Record<string, number> = { 'stream-deckstrip': 90 }
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
          MERCURY_FORCE_SYNC_OUTPUT: '1',
          MEASURE_CHILD: '1',
          MEASURE_SCENE: scene,
          MEASURE_COLS: String(cols),
          INK_WRITE_TEE: tee,
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
    }
    rmSync(dir, { recursive: true, force: true })
    if (r.status !== 0 && lines.length === 0) {
      console.error(`✗ ${scene}: runner failed (status ${r.status})\n${r.stderr ?? ''}`)
      failed = true
      continue
    }
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

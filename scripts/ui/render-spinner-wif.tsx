#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py')
const CONFIG_HOME = resolveProofHome([process.cwd()])

if (process.env.WIF_RENDER_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { SpinnerAnimationRow } = await import(
    '../../src/components/Spinner/SpinnerAnimationRow.js'
  )
  const { publishContextUsage } = await import(
    '../../src/utils/cockpit/contextUsageLive.js'
  )
  publishContextUsage(63, 200_000)

  const cols = Number(process.env.WIF_COLS || '120')
  const ref = <T,>(v: T) => ({ current: v })
  const h = React.createElement
  void render(
    h(SpinnerAnimationRow, {
      mode: 'tool-use',
      reducedMotion: true,
      hasActiveTools: true,
      activeToolCount: 3,
      responseLengthRef: ref(4000),
      message: 'Scuttling',
      messageColor: 'claude',
      shimmerColor: 'claudeShimmer',
      overrideColor: null,
      loadingStartTimeRef: ref(Date.now() - 8000),
      totalPausedMsRef: ref(0),
      pauseStartTimeRef: ref<number | null>(null),
      spinnerSuffix: null,
      verbose: true,
      columns: cols,
      hasRunningTeammates: false,
      teammateTokens: 0,
      foregroundedTeammate: undefined,
      leaderIsIdle: false,
      thinkingStatus: null,
      effortSuffix: '',
    }),
  )
  setTimeout(() => process.exit(0), 1500)
} else if (process.env.OTPS_RENDER_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { SpinnerAnimationRow } = await import(
    '../../src/components/Spinner/SpinnerAnimationRow.js'
  )
  const { publishContextUsage } = await import(
    '../../src/utils/cockpit/contextUsageLive.js'
  )
  publishContextUsage(50, 200_000)
  const cols = Number(process.env.WIF_COLS || '120')
  const h = React.createElement
  const ref = <T,>(v: T) => ({ current: v })
  function OtpsHarness(): React.ReactNode {
    const lenRef = React.useRef(0)
    React.useEffect(() => {
      const id = setInterval(() => {
        lenRef.current += 30
      }, 100)
      return () => clearInterval(id)
    }, [])
    return h(SpinnerAnimationRow, {
      mode: 'responding',
      reducedMotion: false,
      hasActiveTools: false,
      activeToolCount: 0,
      responseLengthRef: lenRef,
      message: 'Streaming',
      messageColor: 'claude',
      shimmerColor: 'claudeShimmer',
      overrideColor: null,
      loadingStartTimeRef: ref(Date.now() - 6000),
      totalPausedMsRef: ref(0),
      pauseStartTimeRef: ref<number | null>(null),
      spinnerSuffix: null,
      verbose: true,
      columns: cols,
      hasRunningTeammates: false,
      teammateTokens: 0,
      foregroundedTeammate: undefined,
      leaderIsIdle: false,
      thinkingStatus: null,
      effortSuffix: '',
    })
  }
  void render(h(OtpsHarness))
  setTimeout(() => process.exit(0), 5000)
} else {
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
    process.exit(1)
  }
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u

  const capture = (cols: number): string => {
    const cfg = `/tmp/vs-wif-${cols}.json`
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, 'run', SELF],
      sends: [],
      total: 15,
      cols,
      rows: 8,
      out: `/tmp/wif-${cols}.json`,
    }))
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME, WIF_RENDER_CHILD: '1', WIF_COLS: String(cols) },
    })
  }

  console.log('============================================================')
  console.log(' cockpit HUD byline render-verify: work-in-flight + ctx gauges')
  console.log('============================================================')

  for (const cols of [120, 80]) {
    console.log(`\n  ── byline @ ${cols} ──`)
    const grid = capture(cols)
    const line = grid.split('\n').find(l => /tools/.test(l)) ?? ''
    console.log(`  byline @${cols}: ${line.trim().slice(0, 78) || '(none)'}`)
    check(`@${cols}: work-in-flight gauge present ("N tools")`, /\d+ tools?\b/.test(grid))
    check(`@${cols}: the in-progress glyph (◐) rides the gauge`, /◐/.test(grid))
    check(`@${cols}: context-burn gauge present ("NN% ctx")`, /\d+% ctx/.test(grid))
    check(`@${cols}: token-burn counter present ("tokens")`, /tokens/.test(grid))
    check(`@${cols}: elapsed timer present`, /\d+s\b|\d+:\d\d/.test(grid))
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
  }

  const otpsCapture = (cols: number): string => {
    const cfg = `/tmp/vs-otps-${cols}.json`
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, 'run', SELF],
      sends: [],
      total: 30,
      cols,
      rows: 8,
      out: `/tmp/otps-${cols}.json`,
    }))
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME, OTPS_RENDER_CHILD: '1', WIF_COLS: String(cols) },
    })
  }
  for (const cols of [120, 80]) {
    console.log(`\n  ── streaming cadence @ ${cols} ──`)
    const grid = otpsCapture(cols)
    const line = grid.split('\n').find(l => /tok\/s/.test(l)) ?? ''
    console.log(`  byline @${cols}: ${line.trim().slice(0, 78) || '(none)'}`)
    check(`@${cols}: streaming-cadence gauge present ("N tok/s")`, /\d+ tok\/s/.test(grid))
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
  }

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ cockpit HUD byline — work-in-flight + ctx + streaming-cadence gauges render @80 + @120')
    process.exit(0)
  } else {
    console.log(` ❌ cockpit HUD byline — ${failures} check(s) failed`)
    process.exit(1)
  }
}

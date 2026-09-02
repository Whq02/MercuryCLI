#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-spinner-wif.tsx — DETERMINISTIC render-verify for the
//  in-turn cockpit HUD's full byline (joins the ui suite under UI_RENDER=1).
//
//  The context-burn gauge is render-verified LIVE in render-spinner-hud.ts, but
//  the WORK-IN-FLIGHT gauge ("◐ N tools") only lights up while >=2 NON-Sleep
//  concurrency-safe tools execute AND the spinner is visible — and the spinner
//  is suppressed precisely when the only in-flight tools are Sleep
//  (onlySleepToolActive), so that case is timing-hostile to catch live. So this
//  mounts SpinnerAnimationRow DIRECTLY with synthetic props (activeToolCount=3,
//  a seeded ctx fill via publishContextUsage) under a real Ink render → pyte
//  capture, at 80 AND 120 cols. Deterministic: no API turn, no tool timing.
//
//  Asserts the full cockpit byline: elapsed timer · ↓ token burn · "NN% ctx"
//  gauge · "◐ N tools" work-in-flight — with NO emoji.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-spinner-wif.tsx
// ============================================================================
process.env.NODE_ENV = 'test' // ThemeProvider/getTheme read getGlobalConfig at mount
// Fork-sim so the build stamp is true (the HUD segments are stamp-gated).
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
const VSHOT = join(dirname(SELF), 'vshot.py') // the in-repo capturer (was the ephemeral /tmp copy)
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

// ── child: render the spinner byline, then exit ─────────────────────────────
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
  // Seed a live context fill so the ctx gauge has a value (MercuryFrame isn't
  // mounted in this standalone render). 63% of a 200k window → "▆ 63% ctx".
  publishContextUsage(63, 200_000)

  const cols = Number(process.env.WIF_COLS || '120')
  const ref = <T,>(v: T) => ({ current: v })
  const h = React.createElement
  void render(
    h(SpinnerAnimationRow, {
      mode: 'tool-use',
      // reducedMotion freezes the animation clock so the capture is stable
      // (exact token count, no glimmer mid-cycle) — the byline PARTS (timer /
      // tokens / ctx / wif) don't depend on the animation, only on width.
      reducedMotion: true,
      hasActiveTools: true,
      activeToolCount: 3,
      responseLengthRef: ref(4000), // → ~1.0k tokens
      message: 'Scuttling',
      messageColor: 'claude',
      shimmerColor: 'claudeShimmer',
      overrideColor: null,
      loadingStartTimeRef: ref(Date.now() - 8000), // → "8s" elapsed
      totalPausedMsRef: ref(0),
      pauseStartTimeRef: ref<number | null>(null),
      spinnerSuffix: null,
      verbose: true, // wantsTimerAndTokens regardless of elapsed
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
  // ── child B: a DYNAMIC mount whose responseLength climbs at a fixed rate, so
  //    the streaming-cadence (tok/s) instrument computes a real, steady value.
  //    30 chars / 100ms = 300 chars/s ÷ 4 ≈ 75 tok/s (EMA-smoothed).
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
      reducedMotion: false, // the rate needs the live animation clock
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
  // ── parent: drive vshot on self at 80 + 120, assert the byline ────────────
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
    process.exit(1)
  }
  // TRUE emoji only (U+1F000+ / VS16) — NOT the geometric dingbat block the kit uses.
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u

  const capture = (cols: number): string => {
    const cfg = `/tmp/vs-wif-${cols}.json`
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, 'run', SELF],
      sends: [],
      total: 15, // 0.2s ticks (~3s ceiling); the child exits at 1.5s → EOF-break early
      cols,
      rows: 8,
      out: `/tmp/wif-${cols}.json`,
    }))
    // vshot.py never reads cfg.env — the child-branch marker rides execFileSync's env.
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
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

  // streaming-cadence (tok/s) instrument — a DYNAMIC mount whose responseLength
  // climbs at a fixed rate (≈75 tok/s); verify the gauge renders a steady value.
  const otpsCapture = (cols: number): string => {
    const cfg = `/tmp/vs-otps-${cols}.json`
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, 'run', SELF],
      sends: [],
      total: 30, // 0.2s ticks (~6s ceiling); the dynamic child exits at 5s → EOF-break
      cols,
      rows: 8,
      out: `/tmp/otps-${cols}.json`,
    }))
    // vshot.py never reads cfg.env — the child-branch marker rides execFileSync's env.
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
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

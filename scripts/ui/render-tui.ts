#!/usr/bin/env bun
import { writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario, RUNTIME_CWD } from './renderScenarios.ts'
import { evaluateCapture } from './renderOracle.ts'
import { gridToPng } from './gridToPng.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

// W6-C: interpreter + temp root come from the ONE capture-driver
// contract. On POSIX the resolver returns EXACTLY '/tmp' (the fixed default
// paths below are a PINNED expectation of the concurrent pty-lane
// byte-identity provers — see captureDriver.ts's temp-root law); a host with
// no viable driver refuses with the truthful remedy instead of dying inside
// a hard-coded spawn.
const driver = resolveCaptureDriver()
// The vshot python inherits process.env — including any scenario's scratch
// HOME — and pyte lives in the USER-SITE path python derives from HOME, so a
// home-swapping scenario starved the capture engine of its own dependency
// (ModuleNotFoundError: pyte, accounts-board-signed-out). Resolve pyte's
// real location ONCE under the pristine env and pin it via PYTHONPATH; the
// TUI child still sees exactly the scenario's env.
const PYTE_PATH = (() => {
  try {
    return spawnSync(driver.kind === 'posix-pty' ? driver.python : 'python3',
      ['-c', 'import pyte, os; print(os.path.dirname(os.path.dirname(pyte.__file__)))'],
      { encoding: 'utf8' }).stdout?.trim() || ''
  } catch { return '' }
})()
if (driver.kind === 'unavailable') {
  console.error(`render-tui: no capture driver — ${driver.reason}\n  ${driver.remedy}`)
  process.exit(2)
}
if (driver.kind !== 'posix-pty') {
  console.error(
    'render-tui: this entrypoint drives the POSIX PTY engine (vshot.py). ' +
      `On this host the driver is '${driver.kind}' — use the ConPTY lane (scripts/winreg) or the hosted windows-ui workflow.`,
  )
  process.exit(2)
}

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def
}
const name = arg('--scenario', 'resume-2turn')
const cols = Number(arg('--cols', '120')), rows = Number(arg('--rows', '44'))
const out = arg('--out', join(driver.tempRoot, `tui-${cols}.png`))
// --grid: an explicit grid path (a caller that must not share the fixed
// temp path with concurrent pty-lane suites — the byte-identity provers).
// The cfg file rides beside it so the pair can never split across writers.
const gridPath = arg('--grid', join(driver.tempRoot, `grid-${cols}.json`))

const cfg = { ...scenario(name, cols, rows), out: gridPath }
// the STANDARD BOOT PREFIX compresses to observed-ready:
// most scenarios open with a slash command at tick 30 (a fixed ~6s boot
// allowance) and ↵ at 36. The composer sigil '❯' gates the command instead
// (minTick 5 keeps a 1s floor; atTick 30 stays the hard deadline — a sigil
// that never paints degrades to the exact old schedule), and the ↵ follows 3
// ticks after the command ACTUALLY fired. ONLY the pure 2-send shape
// converts: a scenario with LATER absolute-tick sends may encode a timing
// contract relative to the old open time (a navigation pin can race a
// board's readiness ON PURPOSE — the STALE-PAINT regression class), so longer
// scripts convert by hand with per-send judgment or not at all.
{
  const s = (cfg as { sends?: Array<Record<string, unknown>> }).sends
  if (
    Array.isArray(s) &&
    s.length === 2 &&
    s[0]?.atTick === 30 &&
    typeof s[0]?.data === 'string' &&
    (s[0].data as string).startsWith('/') &&
    s[0].awaitText === undefined &&
    s[1]?.atTick === 36 &&
    s[1]?.data === '\r'
  ) {
    s[0] = { ...s[0], awaitText: '❯', minTick: 5 }
    s[1] = { afterPrevTicks: 3, data: '\r' }
  }
}
// --total N overrides the scenario's tick budget — mid-flight captures for
// debugging WHEN a transition happens (each tick ≈0.2s).
const totalOverride = arg('--total', '')
if (totalOverride) {
  const n = Number(totalOverride)
  // NaN would serialize to null and OVERRIDE vshot's default (audit L2).
  if (!Number.isFinite(n) || n <= 0) { console.error(`invalid --total: ${totalOverride}`); process.exit(2) }
  cfg.total = n
}
const cfgPath = gridPath.startsWith(join(driver.tempRoot, 'grid-'))
  ? join(driver.tempRoot, `vshot-${cols}.json`)
  : `${gridPath}.cfg.json`
// The sidecar beside a TRACKED grid is the record of its capture: paths under
// the runtime cwd are written relative to it ('.' for the cwd itself,
// 'dist/mercury.mjs' for the bundle). vshot runs from RUNTIME_CWD and honours
// cfg.cwd via os.chdir, so the relative spelling resolves to the same files —
// the capture is unchanged and no checkout's absolute path lands in the tree.
const relativeToRuntimeCwd = (p: string): string =>
  p === RUNTIME_CWD ? '.' : p.startsWith(RUNTIME_CWD + '/') ? p.slice(RUNTIME_CWD.length + 1) : p
const recorded = cfg.cwd === RUNTIME_CWD ? { ...cfg, cwd: '.', argv: cfg.argv.map(relativeToRuntimeCwd) } : cfg
writeFileSync(cfgPath, JSON.stringify(recorded))
// Capture with ONE retry on an oracle failure: the PTY boot occasionally finishes mid-paint →
// a near-empty grid (a render flake, not a real blank screen). The oracle (renderOracle.ts)
// rejects blanks, boot-error screens ("No conversation found" — the MERCURY_CONFIG_DIR
// divergence class), and chrome-less captures, so a verify-by-rendering tool NEVER reports
// a broken boot as a pass — the render_tui MCP tool inherits the retry and the oracle via
// this CLI's exit status (/usr/bin/python3 has pyte).
let verdict: { ok: boolean; reason: string } = { ok: false, reason: 'capture never ran' }
for (let attempt = 1; attempt <= 2; attempt++) {
  // 60s (was 30s): the long scenarios (doctor-detail total=105 ≈ 21s of
  // ticks; a retired board scenario ran 130) breached 30s under FULL-GATE load — the child
  // PTY runs slow when 34 suites contend — and a spawnSync timeout exits with
  // status null and often an EMPTY stderr, so the ui suite went red with every
  // printed proof green. Name
  // the timeout explicitly so the next flake is attributable at a glance.
  const res = spawnSync(driver.python, [join(import.meta.dir, 'vshot.py'), cfgPath], {
    // MERCURY_VSHOT_TIMEOUT_MS: the live billed journeys (cap-journey-live —
    // two REAL model turns) legitimately exceed the 60s suite wall; manual
    // runs may widen it, and the load-honest long
    // journeys set it per-render beside their raised tick budgets. The
    // default suite path keeps the 60s flake-attribution contract above —
    // stretched only under the hosted profile, which stretches vshot's own
    // timeline by the same knob (a wall that ignored it killed the capture
    // it had granted headroom to: run 2's status-null class).
    encoding: 'utf-8', timeout: vshotBudgetMs(Number(process.env.MERCURY_VSHOT_TIMEOUT_MS) || 60000),
    // The PTY child inherits THIS cwd; the staged-session slug derives from
    // RUNTIME_CWD (renderScenarios) — booting anywhere else 404s every
    // scenario, so pin the pair together mechanically (CI-portability: the
    // invoking shell's cwd no longer matters).
    cwd: RUNTIME_CWD,
    // MERCURY_CONFIG_DIR pinned explicitly (pinned home): the
    // bun-side scenario writer and the dist child must resolve ONE home even
    // when this runs outside the gate unit's pin (manual render-tui runs).
    // The pin is the LIVE env value: a scenario that seeds its OWN scratch
    // home (the concourse family, first-run) exports it into process.env
    // before this spawn, and the import-time CONFIG_HOME must not clobber
    // it back to the proof home — that override made every scenario-seeded
    // config (capacity decision, qualification receipts) invisible to the
    // child, so each capture re-ran first-boot regardless of the scenario
    // Scenarios that seed nothing keep the
    // proof-home pin resolveProofHome exported at import.
    env: {
      ...process.env,
      ...(PYTE_PATH ? { PYTHONPATH: [PYTE_PATH, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
      MERCURY_FULLSCREEN: '1', // canonical pin beside the compat spelling — an ambient export must never outrank the rig (2-2-2)
      MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME,
      // NOTE (CI-portability): a fresh machine needs a credential env to boot
      // past the auth gate — the CI workflow declares ANTHROPIC_API_KEY at the
      // job level (gate.yml). Deliberately NOT pinned here: injecting a fake
      // key where local auth is keychain/OAuth CHANGED local account-gated
      // renders.
    },
  })
  if (res.status !== 0) {
    cleanupScenario(name)
    const wallMs = vshotBudgetMs(Number(process.env.MERCURY_VSHOT_TIMEOUT_MS) || 60000)
    const why = res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? `vshot TIMEOUT (${wallMs}ms wall) — scenario '${name}' at ${cols} cols (load-stretched PTY?)`
      : res.stderr ||
        `vshot failed (status ${res.status ?? 'null'}${res.signal ? ` · signal ${res.signal}` : ''}${res.error ? ` · ${String(res.error)}` : ''} · empty stderr)`
    console.error(why)
    process.exit(1)
  }
  // Scenario-supplied chrome markers (a screen may paint
  // no Mercury chrome by design) — default strict set otherwise.
  verdict = evaluateCapture(
    JSON.parse(readFileSync(gridPath, 'utf8')),
    (cfg as { chromeMarkers?: string[] }).chromeMarkers,
  )
  if (verdict.ok) break
}
cleanupScenario(name)
if (!verdict.ok) {
  console.error(`capture rejected after 2 attempts: ${verdict.reason}`)
  process.exit(1)
}
const r = await gridToPng(gridPath, out)
console.log(r.path)

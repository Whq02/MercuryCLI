#!/usr/bin/env bun
import { writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario, RUNTIME_CWD } from './renderScenarios.ts'
import { evaluateCapture } from './renderOracle.ts'
import { gridToPng } from './gridToPng.ts'
import { resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { SETTLE_LAW, cockpitReadyText, settleCaptureConfig, settleNeedles, settleWallMs } from './visualBaseline.ts'
import { HELM_BOTH_RAILS_MIN, HELM_HOME_MIN_COLS } from '../../src/utils/helmGeometry.ts'

const driver = resolveCaptureDriver()
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
{
  const preflight = preflightCaptureDriver(driver, join(import.meta.dir, '..', '..'))
  if (!preflight.ok) {
    console.error(`render-tui: no capture engine — ${describeCapturePreflight(preflight)}`)
    process.exit(2)
  }
}

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def
}
const name = arg('--scenario', 'resume-2turn')
const cols = Number(arg('--cols', '120')), rows = Number(arg('--rows', '44'))
const out = arg('--out', join(driver.tempRoot, `tui-${cols}.png`))
const gridPath = arg('--grid', join(driver.tempRoot, `grid-${cols}.json`))

let cfg = { ...scenario(name, cols, rows), out: gridPath }
const settleWanted = process.argv.includes('--settle')
const sceneNeedles = process.argv.flatMap((a, i, all) => (a === '--needle' && all[i + 1] !== undefined ? [all[i + 1]] : []))
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
const totalOverride = arg('--total', '')
if (totalOverride) {
  const n = Number(totalOverride)
  if (!Number.isFinite(n) || n <= 0) { console.error(`invalid --total: ${totalOverride}`); process.exit(2) }
  cfg.total = n
}
if (settleWanted) {
  const boot = cockpitReadyText(cols, HELM_HOME_MIN_COLS, HELM_BOTH_RAILS_MIN)
  const scene = sceneNeedles.length > 0 ? { readyText: sceneNeedles } : (cfg as { readyText?: string | string[] })
  const stillRegion = arg('--still-region', '')
  const region = stillRegion ? { stableRegion: stillRegion.split(',').map(Number) } : {}
  cfg = settleCaptureConfig({ ...cfg, ...scene, ...region }, settleNeedles(scene, boot), boot) as typeof cfg
}
const wallMs = settleWanted
  ? settleWallMs(SETTLE_LAW, vshotBudgetScale())
  : vshotBudgetMs(Number(process.env.MERCURY_VSHOT_TIMEOUT_MS) || 60000)
const cfgPath = gridPath.startsWith(join(driver.tempRoot, 'grid-'))
  ? join(driver.tempRoot, `vshot-${cols}.json`)
  : `${gridPath}.cfg.json`
const relativeToRuntimeCwd = (p: string): string =>
  p === RUNTIME_CWD ? '.' : p.startsWith(RUNTIME_CWD + '/') ? p.slice(RUNTIME_CWD.length + 1) : p
const recorded = cfg.cwd === RUNTIME_CWD ? { ...cfg, cwd: '.', argv: cfg.argv.map(relativeToRuntimeCwd) } : cfg
writeFileSync(cfgPath, JSON.stringify(recorded))
let verdict: { ok: boolean; reason: string } = { ok: false, reason: 'capture never ran' }
for (let attempt = 1; attempt <= 2; attempt++) {
  const res = spawnSync(driver.python, [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf-8', timeout: wallMs,
    cwd: RUNTIME_CWD,
    env: {
      ...process.env,
      ...(PYTE_PATH ? { PYTHONPATH: [PYTE_PATH, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
      MERCURY_FULLSCREEN: '1',
      MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME,
      MERCURY_NPM_REGISTRY_BASE: 'http://127.0.0.1:1',
    },
  })
  if (res.status !== 0) {
    cleanupScenario(name)
    const why = res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? `vshot TIMEOUT (${wallMs}ms wall) — scenario '${name}' at ${cols} cols (load-stretched PTY?)`
      : res.stderr ||
        `vshot failed (status ${res.status ?? 'null'}${res.signal ? ` · signal ${res.signal}` : ''}${res.error ? ` · ${String(res.error)}` : ''} · empty stderr)`
    console.error(why)
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c?: string }>> }
  verdict = evaluateCapture(payload, (cfg as { chromeMarkers?: string[] }).chromeMarkers)
  if (verdict.ok) break
}
cleanupScenario(name)
if (!verdict.ok) {
  console.error(`capture rejected after 2 attempts: ${verdict.reason}`)
  process.exit(1)
}
const r = await gridToPng(gridPath, out)
console.log(r.path)

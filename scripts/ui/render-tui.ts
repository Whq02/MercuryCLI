#!/usr/bin/env bun
import { writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario, RUNTIME_CWD } from './renderScenarios.ts'
import { evaluateCapture } from './renderOracle.ts'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS, viewportFloorLine } from '../../src/ink/viewportFloor.ts'
import { gridToPng } from './gridToPng.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

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

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def
}
const name = arg('--scenario', 'resume-2turn')
const cols = Number(arg('--cols', '120')), rows = Number(arg('--rows', '44'))
const out = arg('--out', join(driver.tempRoot, `tui-${cols}.png`))
const gridPath = arg('--grid', join(driver.tempRoot, `grid-${cols}.json`))

const cfg = { ...scenario(name, cols, rows), out: gridPath }
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
    encoding: 'utf-8', timeout: vshotBudgetMs(Number(process.env.MERCURY_VSHOT_TIMEOUT_MS) || 60000),
    cwd: RUNTIME_CWD,
    env: {
      ...process.env,
      ...(PYTE_PATH ? { PYTHONPATH: [PYTE_PATH, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
      MERCURY_FULLSCREEN: '1',
      MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME,
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
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c?: string }>> }
  if (cols < VIEWPORT_FLOOR_COLS || rows < VIEWPORT_FLOOR_ROWS) {
    const line = viewportFloorLine(cols, rows)
    const text = payload.grid.map(row => row.map(c => c.c ?? '').join('')).join('\n')
    verdict = text.includes(line)
      ? { ok: true, reason: `under the viewport floor: the one line painted` }
      : { ok: false, reason: `under the viewport floor but its line is not painted (looked for: ${line})` }
  } else {
    verdict = evaluateCapture(payload, (cfg as { chromeMarkers?: string[] }).chromeMarkers)
  }
  if (verdict.ok) break
}
cleanupScenario(name)
if (!verdict.ok) {
  console.error(`capture rejected after 2 attempts: ${verdict.reason}`)
  process.exit(1)
}
const r = await gridToPng(gridPath, out)
console.log(r.path)

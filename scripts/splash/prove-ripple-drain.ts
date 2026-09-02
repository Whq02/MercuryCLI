#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const SPLASH = join(ROOT, 'assets/splash/mercury-splash.mjs')
const PROBE = join(ROOT, 'scripts/splash/ripple-probe.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

interface ProbeReport {
  tag: string
  bytes: number
  writes: number
  enterToReportMs: number | null
  cancelToReportMs: number | null
  rippleWallMs: number | null
  stalledWrites: number
}

function runProbe(opts: {
  mode: string
  drainMs?: number
  script: string
  extraEnv?: Record<string, string>
}): { code: number | null; report: ProbeReport | null; home: string; cleanup: () => void } {
  const scratch = mkdtempSync(join(tmpdir(), 'ripple-drain-'))
  const home = join(scratch, 'home')
  const configDir = join(scratch, 'mercury-home')
  const reportPath = join(scratch, 'report.json')
  const res = spawnSync(
    process.execPath.includes('bun') ? 'node' : process.execPath,
    [PROBE, SPLASH, '120', '30', opts.mode, String(opts.drainMs ?? 0), opts.script],
    {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        MERCURY_CONFIG_DIR: configDir,
        PROBE_REPORT: reportPath,
        ...opts.extraEnv,
      },
      timeout: 20_000,
      encoding: 'utf8',
    },
  )
  let report: ProbeReport | null = null
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as ProbeReport
  } catch {
    report = null
  }
  return {
    code: res.status,
    report,
    home: configDir,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  }
}

function readAction(configDir: string): string | null {
  const p = join(configDir, 'splash-action.json')
  if (!existsSync(p)) return null
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as { action?: unknown }
    return typeof o.action === 'string' && o.action !== '' ? o.action : null
  } catch {
    return null
  }
}

console.log('─'.repeat(76))
console.log('· ripple bounded-drain law (fake-TTY probe legs)')
console.log('─'.repeat(76))

{
  const r = runProbe({ mode: 'instant', script: 'noop@1' })
  check('auto: exits 0 on its own (no input sent)', r.code === 0, `code=${r.code} tag=${r.report?.tag}`)
  check(
    'auto: the animation ran (frames written, completion-driven exit)',
    (r.report?.writes ?? 0) > 40,
    `writes=${r.report?.writes}`,
  )
  r.cleanup()
}

{
  const r = runProbe({ mode: 'instant', script: 'enter@300' })
  check('skip: ↵ fast-forwards to exit 0', r.code === 0, `code=${r.code} tag=${r.report?.tag}`)
  check(
    'skip: the fast-forward is prompt (≤4s from ↵)',
    (r.report?.enterToReportMs ?? Infinity) <= 4000,
    `enterToReportMs=${r.report?.enterToReportMs}`,
  )
  r.cleanup()
}

{
  const r = runProbe({ mode: 'stall', script: 'enter@700' })
  check(
    'stall: ↵ boot self-exits (no HARNESS-KILL wedge)',
    r.code === 0 && r.report?.tag === 'exit-0',
    `code=${r.code} tag=${r.report?.tag}`,
  )
  check(
    'stall: the exit is bounded (≤6s from ↵; the wedge signature is 12s)',
    (r.report?.enterToReportMs ?? Infinity) <= 6000,
    `enterToReportMs=${r.report?.enterToReportMs}`,
  )
  check('stall: the drain genuinely stalled (leg validity)', (r.report?.stalledWrites ?? 0) >= 1)
  r.cleanup()
}

{
  const r = runProbe({ mode: 'stall0', script: 'ctrlc@600' })
  check('stall+^C: exit code 130', r.code === 130, `code=${r.code} tag=${r.report?.tag}`)
  check(
    'stall+^C: cancel→exit ≤4s',
    (r.report?.cancelToReportMs ?? Infinity) <= 4000,
    `cancelToReportMs=${r.report?.cancelToReportMs}`,
  )
  check('stall+^C: the cancel action is written', readAction(r.home) === 'cancel', `action=${readAction(r.home)}`)
  r.cleanup()
}

{
  const r = runProbe({ mode: 'stall0', script: 'sigint@600' })
  check('stall+SIGINT: exit code 130', r.code === 130, `code=${r.code} tag=${r.report?.tag}`)
  check('stall+SIGINT: the cancel action is written', readAction(r.home) === 'cancel')
  r.cleanup()
}

{
  const r = runProbe({ mode: 'stall', script: 'enter@700,resize@1500' })
  check('stall+resize: exits 0 (the boot proceeds)', r.code === 0, `code=${r.code} tag=${r.report?.tag}`)
  check(
    'stall+resize: the exit is bounded (≤6s from ↵, the drain cap owns it)',
    (r.report?.enterToReportMs ?? Infinity) <= 6000,
    `enterToReportMs=${r.report?.enterToReportMs}`,
  )
  check('stall+resize: no cancel action (a resize is not a cancel)', readAction(r.home) === null)
  r.cleanup()
}

{
  const r = runProbe({ mode: 'slow', drainMs: 3000, script: 'enter@700' })
  check('slow(3s): exits 0', r.code === 0, `code=${r.code} tag=${r.report?.tag}`)
  check(
    'slow(3s): bounded exit (≤8s from ↵ — today the pacing would take NF×3s)',
    (r.report?.enterToReportMs ?? Infinity) <= 8000,
    `enterToReportMs=${r.report?.enterToReportMs}`,
  )
  r.cleanup()
}

{
  const r = runProbe({ mode: 'instant', script: 'noop@1', extraEnv: { MERCURY_LAUNCH_RIPPLE: '0' } })
  check('RIPPLE=0: exits 0 promptly on its own', r.code === 0 && (r.report?.writes ?? 99) < 40,
    `code=${r.code} writes=${r.report?.writes}`)
  check('RIPPLE=0: no cancel action', readAction(r.home) === null)
  r.cleanup()
}

console.log(failures === 0 ? '\n✅ prove-ripple-drain — all legs green' : `\n❌ prove-ripple-drain — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

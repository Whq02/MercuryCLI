#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-health-mcp-row.ts — the /health MCP-policy row names
// its servers (the row that read `1 server(s): [object
//  Object]` — it joined McpServerRow objects instead of their names).
//
//  Two legs on the BUILT bundle with a fixture stdio server configured in a
//  seeded scratch home (`mcpServers.fixture-echo`):
//    J   `doctor --json` — the mcp row's evidence names `fixture-echo (`
//        with its state, and no evidence string anywhere reads
//        `[object Object]`
//    S   the cockpit at 120×40 — `/health` painted, the MCP policy row
//        carries `fixture-echo`, and no grid cell holds `[object Object]`
//        (the estate's resumed-session boot recipe; the capture is written
//        beside the grid for the record)
//  Poison control: with MERCURY_BASE_DIST naming a pre-fix bundle, its
//  `doctor --json` row reads `[object Object]` ([SKIP] when unset —
//  prove-health-evidence-strings' static walker is the standing poison for
//  the composer's source).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// realpath: the OS temp root is a symlink on macOS; the resumed session is
// keyed by the cwd the child boots under.
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-health-mcp-row-')))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_RENDER_CWD = CWD
delete process.env.NODE_ENV
delete process.env.CI

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const scenarios = await import('../ui/renderScenarios.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
seedFirstRun(HOME, [CWD])
const cfgPath = join(HOME, '.mercury.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
cfg['mcpServers'] = { 'fixture-echo': { type: 'stdio', command: 'node', args: ['-e', 'setInterval(() => {}, 1000000)'] } }
writeFileSync(cfgPath, JSON.stringify(cfg))

type Row = { id?: string; label?: string; evidence?: string }
function mcpRowOf(jsonText: string): Row | undefined {
  let found: Row | undefined
  const walk = (o: unknown): void => {
    if (found) return
    if (Array.isArray(o)) {
      for (const v of o) walk(v)
      return
    }
    if (o && typeof o === 'object') {
      const r = o as Row
      if (r.id === 'mcp' || r.label === 'MCP policy') {
        found = r
        return
      }
      for (const v of Object.values(o)) walk(v)
    }
  }
  try {
    walk(JSON.parse(jsonText))
  } catch {
    return undefined
  }
  return found
}
function doctorJson(bin: string): { text: string; status: number | null } {
  const res = spawnSync('node', [bin, 'doctor', '--json'], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_HOME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { text: res.stdout ?? '', status: res.status }
}

try {
  console.log('J doctor --json names the fixture server on the mcp row')
  const j = doctorJson(BIN)
  const row = mcpRowOf(j.text)
  check('doctor --json produces the record (0/3 by verdict — FC-044) and carries the mcp row', (j.status === 0 || j.status === 3) && row !== undefined, `status=${String(j.status)}`)
  check('the row names the server with its state', typeof row?.evidence === 'string' && /\bfixture-echo \((configured|starting|failed|ready|needs-auth|disabled)\)/.test(row.evidence), row?.evidence?.slice(0, 120) ?? '')
  check('no evidence anywhere reads [object Object]', !j.text.includes('[object Object]'))

  console.log('S the cockpit at 120×40 — the MCP policy row carries the server name')
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  } else {
    scenarios.writeSyntheticSession('short')
    const ESC = '\x1b'
    const out = join(SCRATCH, 'health-120x40.json')
    const vcfg = {
      argv: ['node', BIN, '--resume', scenarios.SID],
      cwd: CWD,
      cols: 120,
      rows: 40,
      // The bracketed-paste arm is the composer's own "input is live"
      // declaration (the causal-ready class); minTick 30 is the estate's
      // proven local cadence floor. The certificate is an INLINE surface
      // with async rows, so the budget is fixed.
      sends: [
        { atTick: 140, awaitRaw: `${ESC}[?2004h`, minTick: 30, data: '/health' },
        { afterPrevTicks: 6, data: '\r' },
      ],
      total: 110,
      out,
    }
    const vcfgPath = join(SCRATCH, 'vshot-cfg.json')
    writeFileSync(vcfgPath, JSON.stringify(vcfg))
    const res = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), vcfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(240_000),
      env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_LIVE_GLYPHS: '0' },
    })
    check('the capture ran', res.status === 0, (res.stderr ?? '').slice(-200))
    let lines: string[] = []
    try {
      const grid = JSON.parse(readFileSync(out, 'utf8')) as { grid: { c: string }[][] }
      lines = grid.grid.map(r => r.map(c => c.c || ' ').join(''))
    } catch {
      lines = []
    }
    const captureDir = process.env.MERCURY_HEALTH_CAPTURE_DIR
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true })
      writeFileSync(join(captureDir, 'health-mcp-row-120x40.txt'), lines.join('\n') + '\n')
    }
    const mcpLine = lines.find(l => l.includes('MCP policy')) ?? ''
    // The surface's subtitle is 'health certificate'.
    check('/health painted its certificate', lines.some(l => l.includes('health certificate')))
    check('the MCP policy row is on screen and names the fixture server', mcpLine.includes('fixture-echo'), mcpLine.trim().slice(0, 120))
    check('no grid cell holds [object Object]', !lines.some(l => l.includes('[object Object]')))
  }

  console.log('P poison: a pre-fix bundle prints [object Object] on the same row (MERCURY_BASE_DIST)')
  const baseDist = process.env.MERCURY_BASE_DIST
  if (baseDist && existsSync(join(baseDist, 'mercury.mjs'))) {
    const b = doctorJson(join(baseDist, 'mercury.mjs'))
    const brow = mcpRowOf(b.text)
    check('the pre-fix row reads [object Object]', brow?.evidence?.includes('[object Object]') === true, brow?.evidence?.slice(0, 80) ?? '')
  } else {
    console.log('  [SKIP] MERCURY_BASE_DIST unset — prove-health-evidence-strings holds the standing poison for the composer source')
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? 'HEALTH MCP ROW LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-live-connect.ts — the REAL interactive connect flow
//  over the owned registry.
//
//  prove-mcp-registry.ts pins the state machine hermetically; THIS proof
//  drives the shipped artifact end to end: boot `dist/mercury.mjs` in a real
//  PTY with --strict-mcp-config + one stdio fixture server
//  (_fixture-stdio-server.mjs), open /mcp, and assert the server reached
//  "connected" through the registry → hook-projection → AppState → panel
//  path. This is the flow the Phase 4 hook cutover changed — a wiring break
//  (registry not seeded, events not projected, onclose not routed) fails
//  HERE, not just in unit contracts.
//
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-mcp-live-connect.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const FIXTURE_SERVER = join(import.meta.dir, '_fixture-stdio-server.mjs')
// OWN scratch config home: the tmp fixture cwd can
// never be pre-trusted by ANY ambient home — the prover seeds its own,
// keyed by the cwd's REALPATH (macOS tmpdir is a /private symlink; the
// trust lookup resolves it).
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'mcp-live-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' MCP live connect — real PTY, real artifact, stdio fixture')
console.log('============================================================')

if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists (build first)', false)
  process.exit(1)
}

// Fixture cwd OUTSIDE the repo tree: an in-repo cwd
// inherits every ancestor's project surface — the mcp-config discovery walk
// found the OPERATOR'S ~/.mcp.json through /Users/... ancestors and parked a
// consent card over the capture. tmpdir has no meaningful ancestors on any
// machine. (The old journey-fixtures nicety — Projects-picker visibility —
// was never load-bearing for THIS prover.)
const FIX = join(tmpdir(), `mcp-live-fix-${process.pid}`)
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# mcp live-connect fixture\n')

// FIRST-RUN SEED: onboard the
// scratch home + trust the fixture cwd under BOTH spellings (raw + realpath).
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(CONFIG_HOME, [FIX, realpathSync(FIX)])

const mcpCfgPath = join(tmpdir(), `mcp-live-cfg-${process.pid}.json`)
// OP-4 identity proof: the fixture server records the initialize params it
// receives ON THE WIRE so the clientInfo assertion below reads real bytes.
const clientInfoLog = join(tmpdir(), `mcp-live-clientinfo-${process.pid}.jsonl`)
writeFileSync(
  mcpCfgPath,
  JSON.stringify({
    mcpServers: {
      fixsrv: {
        type: 'stdio',
        command: process.execPath.includes('bun') ? 'node' : process.execPath,
        args: [FIXTURE_SERVER],
        env: { MCP_FIXTURE_LOG: clientInfoLog },
      },
    },
  }),
)

const SCRATCH = (name: string) => join(tmpdir(), `mcp-live-${name}-${process.pid}`)
const gridPath = join(tmpdir(), `mcp-live-grid-${process.pid}.json`)
const cfgPath = join(tmpdir(), `mcp-live-vshot-${process.pid}.json`)
writeFileSync(
  cfgPath,
  JSON.stringify({
    argv: ['node', BIN, '--strict-mcp-config', '--mcp-config', mcpCfgPath],
    cwd: FIX,
    // Give the boot + stdio connect ~6s, then open the /mcp panel and let it
    // paint. Total 70 ticks = 14s wall clock.
    // Observed-ready send: tick 30 was a
    // warm-machine calibration — a cold fresh-home boot (CI, scratch homes)
    // reaches the composer later and the send was swallowed pre-mount, so
    // /mcp never opened. Gate on the painted composer instead; the fixed
    // atTick stays as the hard fallback deadline.
    // THE LANDING RULE (L15/Law 9): a bare boot lands the Boot FACE, whose
    // card paints a '❯' caret of its own — the old composer gate fired on it
    // and typed /mcp INTO THE FACE (the panel never opened). The canonical
    // face-↵ prelude enters New Session first; /mcp then gates on the CHAT's
    // own composer placeholder.
    sends: [
      { atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' },
      { atTick: 90, minTick: 5, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: '/mcp\r' },
    ],
    total: 140,
    cols: 120,
    rows: 50,
    out: gridPath,
  }),
)

const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf8',
  timeout: vshotBudgetMs(180_000),
  env: {
    ...process.env,
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_DAEMON_DIR: SCRATCH('daemon'),
    MERCURY_TEAMS_DIR: SCRATCH('teams'),
    MERCURY_TABULA_DIR: SCRATCH('tabula'),
    MERCURY_HOME: SCRATCH('home'),
    VISUAL: '',
    EDITOR: '',
  },
})
if (res.status !== 0) {
  check('PTY capture ran', false, (res.stderr ?? '').slice(0, 300))
  process.exit(1)
}

type Cell = { c: string }
const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
const lines = grid.map(r => r.map(c => c.c).join(''))
const screen = lines.join('\n')

const inkCells = screen.replace(/\s/g, '').length
check('frame is painted (no all-blank grid)', inkCells > 400, `${inkCells} ink cells`)

const fixsrvLine = lines.find(l => l.includes('fixsrv'))
check('the /mcp panel lists the fixture server', fixsrvLine !== undefined, screen.slice(0, 1500))
check(
  'fixsrv reached CONNECTED through the owned registry path',
  /connected/.test(fixsrvLine ?? ''),
  `line: ${JSON.stringify(fixsrvLine)}`,
)
check(
  'the server is not stuck connecting/failed',
  !/connecting|failed|needs auth/i.test(fixsrvLine ?? ''),
  `line: ${JSON.stringify(fixsrvLine)}`,
)

// ── OP-4: the ON-WIRE client identity is Mercury ────────────────────────────
{
  let initParams: { clientInfo?: { name?: string; title?: string; websiteUrl?: string } } | null = null
  try {
    const raw = readFileSync(clientInfoLog, 'utf8').trim().split('\n')[0]
    initParams = raw ? (JSON.parse(raw) as typeof initParams) : null
  } catch {
    initParams = null
  }
  check('the fixture recorded the initialize params', initParams !== null)
  check(
    "OP-4: on-wire clientInfo.name === 'mercury'",
    initParams?.clientInfo?.name === 'mercury',
    JSON.stringify(initParams?.clientInfo ?? null),
  )
  check("OP-4: on-wire clientInfo.title === 'Mercury'", initParams?.clientInfo?.title === 'Mercury')
  check(
    'OP-4: no borrowed product URL in clientInfo',
    initParams?.clientInfo?.websiteUrl === undefined,
    String(initParams?.clientInfo?.websiteUrl),
  )
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ MCP LIVE CONNECT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} MCP LIVE-CONNECT FAILURE(S)`)
process.exit(1)

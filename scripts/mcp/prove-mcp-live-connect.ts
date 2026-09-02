#!/usr/bin/env bun
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

const FIX = join(tmpdir(), `mcp-live-fix-${process.pid}`)
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# mcp live-connect fixture\n')

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(CONFIG_HOME, [FIX, realpathSync(FIX)])

const mcpCfgPath = join(tmpdir(), `mcp-live-cfg-${process.pid}.json`)
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

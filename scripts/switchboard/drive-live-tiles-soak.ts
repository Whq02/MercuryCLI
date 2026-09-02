#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tiles-soak-')))
const daemonDir = join(SCRATCH, 'daemon')
for (const d of [daemonDir]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const SIZE = { cols: 120, rows: 40 }
const KEEP_DIR = process.env.MERCURY_TILES_CAPTURE_DIR
const NAMES = ['alpha', 'beta', 'gamma', 'delta'] as const
const TOKENS = 300
const GAP_MS = 2000

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  ...NAMES.map(n => ({
    kind: 'paced' as const,
    deltas: Array.from({ length: TOKENS }, (_, i) => `soak-${n} ${String(i + 1).padStart(3, '0')} `),
    gapMs: GAP_MS,
    settleDelayMs: 2000,
  })),
  { kind: 'text' as const, text: 'Spare.' },
  { kind: 'text' as const, text: 'Spare.' },
])

const works: Record<string, string> = {}
for (const n of NAMES) {
  works[n] = join(SCRATCH, `work-${n}`)
  mkdirSync(works[n]!, { recursive: true })
}

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemonWithHome = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', works['alpha']!], {
    cwd: works['alpha']!,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const untilAsync = async (pred: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const seatProjections = await import('../../src/services/engine-connector/seatProjections.ts')

const sessionIds: Record<string, string> = {}
const ledger: Record<string, number[]> = {}
for (const n of NAMES) ledger[n] = []
const tokenIn = (text: string | null | undefined, name: string): number => {
  if (!text) return -1
  return Math.max(-1, ...[...text.matchAll(new RegExp(`soak-${name} (\\d{3})`, 'g'))].map(m => Number(m[1])))
}
let sampler: ReturnType<typeof setInterval> | null = null

try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: ['300000:\t', '301000:\x1b[B', '302000:\x1b[B'],
    seconds: 640,
    cols: SIZE.cols,
    rows: SIZE.rows,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, ...Object.values(works)])
      const cfgPath = join(configDir, '.mercury.json')
      let cfg: Record<string, unknown> = {}
      try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      } catch {
      }
      cfg.switchboardCapacity = { askedAt: Date.now(), allowed: true, recommendedSeats: 6 }
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      for (const n of NAMES) {
        const r = (await daemonControlRpc({
          op: 'concourseDispatch',
          clientMessageId: `soak-${n}-1`,
          prompt: `stream the ${n} soak body`,
          workspaceDir: works[n]!,
          title: `Soak ${n}`,
          modelKey: 'claude-opus-5',
          effort: 'xhigh',
        } as never)) as { ok?: boolean; sessionId?: string }
        check(`${n} dispatched`, r.ok === true && r.sessionId !== undefined, JSON.stringify(r))
        sessionIds[n] = r.sessionId ?? ''
        const t = join(paths.getProjectDir(works[n]!), `${r.sessionId}.jsonl`)
        check(
          `${n} claimed its own turn (marker on disk)`,
          await untilAsync(async () => {
            try {
              const tail = seatProjections.readSessionTail(sessionIds[n]!, daemonDir)
              if (tokenIn(tail?.text, n) >= 1) return true
              return existsSync(t) && readFileSync(t, 'utf8').includes(`soak-${n} 001`)
            } catch {
              return false
            }
          }, 40_000),
        )
      }
      sampler = setInterval(() => {
        for (const n of NAMES) {
          const tail = seatProjections.readSessionTail(sessionIds[n]!, daemonDir)
          const tok = tokenIn(tail?.text, n)
          if (tok >= 0) ledger[n]!.push(tok)
        }
      }, 10_000)
      sampler.unref?.()
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  if (sampler !== null) clearInterval(sampler)
  try {
    const batches = [
      Array.from({ length: 10 }, (_, i) => 20000 + i * 20000),
      Array.from({ length: 10 }, (_, i) => 220000 + i * 20000),
      Array.from({ length: 10 }, (_, i) => 420000 + i * 20000),
    ]
    const grabs: Array<{ atMs: number; rows: string[] }> = []
    for (const b of batches) {
      try {
        grabs.push(...grabScreens(run, SIZE.cols, SIZE.rows, b))
      } catch (e) {
        console.log(`  [info] grab batch failed (${String(e).slice(0, 80)}) — continuing with what landed`)
      }
    }
    check('frames landed across the soak', grabs.length >= 20, `${grabs.length} frames`)
    if (KEEP_DIR) {
      mkdirSync(KEEP_DIR, { recursive: true })
      for (const g of grabs.filter(x => [20000, 300000, 600000].includes(x.atMs))) {
        writeFileSync(join(KEEP_DIR, `soak-${SIZE.cols}x${SIZE.rows}-at${g.atMs}.txt`), g.rows.map(r => r.replace(/\s+$/, '')).join('\n'))
      }
    }
    const rowOf = (g: { rows: string[] }, n: string): string => g.rows.find(r => new RegExp(`Soak ${n}\\s{2,}`).test(r)) ?? ''
    let crossed = 0
    for (const g of grabs) {
      for (const n of NAMES) {
        const row = rowOf(g, n)
        if (row === '') continue
        for (const other of NAMES) {
          if (other !== n && row.includes(`soak-${other}`)) crossed++
        }
      }
    }
    check('S1 no wrong-session text in any tile (30×4 rows)', crossed === 0, `${crossed} crossings`)
    for (const n of NAMES) {
      const toks = grabs.map(g => tokenIn(rowOf(g, n), n)).filter(t => t >= 0)
      const peak = Math.max(...toks)
      const climb = toks.slice(0, toks.indexOf(peak) + 1)
      check(`S2 ${n}'s tile grew across the soak`, climb.length >= 5 && peak > climb[0]! && peak >= 200, `${toks.length} readings ${climb[0] ?? '—'}→peak ${peak}`)
    }
    let worst = 0
    let readings = 0
    for (const g of grabs) {
      for (const n of NAMES) {
        const t = tokenIn(rowOf(g, n), n)
        if (t < 0 || ledger[n]!.length === 0) continue
        if (t <= 5 && g.atMs > 120000) continue
        readings++
        const d = Math.min(...ledger[n]!.map(s => Math.abs(s - t)))
        if (d > worst) worst = d
      }
    }
    check('S3 every live tile token sits within 12 tokens (≈24 s) of the session\'s own tail ledger', readings >= 20 && worst <= 12, `${readings} readings, worst distance ${worst}`)
    const clocks = new Set(grabs.map(g => (g.rows.join('\n').match(/\b(\d{2}:\d{2}:\d{2})\b/) ?? [])[1] ?? ''))
    check('S4 the clock advances across the soak', clocks.size >= grabs.length * 0.6, `${clocks.size} distinct clocks over ${grabs.length} frames`)
    const lateSel = grabs.filter(g => g.atMs >= 320000).map(g => g.rows.find(r => r.includes('▸')) ?? '')
    check('S4 the minute-5 selection move landed (▸ on the third row)', lateSel.some(r => r.includes('Soak gamma') || r.includes('Soak delta') || r.includes('Soak beta')), lateSel[0]?.trim().slice(0, 60) ?? 'none')
    const degraded = grabs.filter(g => g.rows.join('\n').includes('tiles show summaries'))
    check('S5 no degrade under 4 live tiles', degraded.length === 0, degraded.length > 0 ? `frames: ${degraded.map(g => g.atMs).join(',')}` : '')
  } finally {
    run.cleanup()
  }
} finally {
  if (sampler !== null) clearInterval(sampler)
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await api.close()
  if (process.env.TILES_SOAK_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\ndrive-live-tiles-soak 4x10min: SOAK HOLDS' : `\ndrive-live-tiles-soak: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

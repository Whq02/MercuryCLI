#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'work-chip-drive-')))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const workB = join(SCRATCH, 'work-beta')
for (const d of [daemonDir, work, workB]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const SIZE = process.env.MERCURY_WORK_CHIP_SIZE === '100x30' ? { cols: 100, rows: 30 } : { cols: 120, rows: 40 }
const KEEP_DIR = process.env.MERCURY_WORK_CHIP_CAPTURE_DIR

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')

const WORKFLOW_SCRIPT = [
  "export const meta = { name: 'chip-probe', description: 'work-chip drive', phases: [{ title: 'Probe' }] }",
  "phase('Probe')",
  "const a = await agent('reply with the word done and nothing else', { model: 'claude-sonnet-5' })",
  'return { a }',
].join('\n')

const api = await startFixtureApi([
  { kind: 'text', whenModel: 'opus', text: 'ready.' },
  { kind: 'tool_use', whenModel: 'opus', name: 'Workflow', input: { script: WORKFLOW_SCRIPT }, preText: 'launching the probe. ' },
  { kind: 'text', whenModel: 'opus', text: 'workflow launched.' },
  { kind: 'paced', whenModel: 'sonnet', deltas: Array.from({ length: 120 }, () => 'working. '), gapMs: 500, settleDelayMs: 500 },
  { kind: 'tool_use', whenModel: 'haiku', name: 'Agent', input: { description: 'helper', prompt: 'reply with the word done', run_in_background: true }, preText: 'dispatching a helper. ' },
  { kind: 'text', whenModel: 'haiku', text: 'helper dispatched.' },
  { kind: 'paced', whenModel: 'haiku', deltas: Array.from({ length: 120 }, () => 'helping. '), gapMs: 500, settleDelayMs: 500 },
  { kind: 'text', text: 'hi from B.' },
  { kind: 'text', text: 'noted.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
  { kind: 'text', text: 'done.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemonWithHome = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TOOL_SEARCH: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
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
const proj = await import('../../src/services/engine-connector/seatProjections.ts')

let alphaId = ''
let betaId = ''
const workerPids: number[] = []
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: ['9000:\t', '12000:\x1b[B', '15000:\x1b[A', '18000:\x1b[C', '22000:\x1b[C'],
    seconds: 27,
    cols: SIZE.cols,
    rows: SIZE.rows,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work, workB])
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Workflow', 'Agent', 'Task'] } }))
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'chip-alpha-1',
        prompt: 'say ready',
        workspaceDir: work,
        title: 'Alpha worker',
        modelKey: 'claude-opus-5',
        effort: 'high',
      } as never)) as { ok?: boolean; sessionId?: string; runnerId?: string }
      check('alpha dispatched', a.ok === true && a.sessionId !== undefined, JSON.stringify(a))
      alphaId = a.sessionId ?? ''
      const transcriptOf = (sid: string): string | null => {
        const root = join(configDir, 'projects')
        if (!existsSync(root)) return null
        for (const entry of readdirSync(root)) {
          const candidate = join(root, entry, `${sid}.jsonl`)
          if (existsSync(candidate)) return candidate
        }
        return null
      }
      check('alpha\'s first turn settles', await untilAsync(() => {
        const p = transcriptOf(alphaId)
        return p !== null && readFileSync(p, 'utf8').includes('ready.')
      }, 60_000))
      const grant = (await daemonControlRpc({ op: 'concourseControl', action: 'grant-workflows', sessionId: alphaId, by: 'operator' } as never)) as { ok?: boolean }
      check('the workflows-allowed tag grants', grant.ok === true, JSON.stringify(grant))
      check('alpha\'s workflow is LIVE in its facts', await untilAsync(() => (proj.readSessionFacts(alphaId)?.work ?? []).some(r => r.kind === 'workflow' && r.status === 'running'), 90_000))
      const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
      const connA = seat.daemonSessionConnectorFor({
        sessionId: alphaId,
        runnerId: a.runnerId ?? 'concourse-w1',
        title: 'Alpha worker',
        projectLabel: basename(work),
        workspaceId: work,
        home: paths.getProjectDir(work),
        modelKey: 'claude-opus-5',
      })
      await connA.attach()
      await connA.setModel('claude-haiku-4-5')
      await connA.sendWords('dispatch a background helper')
      check('alpha\'s helper agent is LIVE in its facts (multi-work)', await untilAsync(() => (proj.readSessionFacts(alphaId)?.work ?? []).some(r => r.kind === 'agent' && r.status === 'running'), 60_000))
      connA.detach()
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'chip-beta-1',
        prompt: 'just say hi',
        workspaceDir: workB,
        title: 'Beta idle',
        modelKey: 'claude-opus-5',
        effort: 'high',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('beta dispatched', b.ok === true && b.sessionId !== undefined, JSON.stringify(b))
      betaId = b.sessionId ?? ''
      const sup = await import('../../src/daemon/concourseSupervisor.ts')
      for (const rec of Object.values(sup.readSessionWorkers(daemonDir))) {
        if (rec.pid !== undefined && rec.endedAt === undefined) workerPids.push(rec.pid)
      }
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
    },
  })
  try {
    const offsets = [8000, 10000, 11000, 13000, 14000, 16000, 17000, 19000, 20000, 21000, 23000, 24000, 26000]
    const grabs = grabScreens(run, SIZE.cols, SIZE.rows, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    if (KEEP_DIR) {
      mkdirSync(KEEP_DIR, { recursive: true })
      for (const g of grabs) {
        writeFileSync(join(KEEP_DIR, `chip-${SIZE.cols}x${SIZE.rows}-at${g.atMs}.txt`), g.rows.map(r => r.replace(/\s+$/, '')).join('\n'))
      }
    }
    const boardFrames = grabs.filter(g => text(g).includes('SESSIONS'))
    check('the board painted', boardFrames.length > 0, `frames: ${boardFrames.map(g => g.atMs).join(',')}`)
    const selRowIndex = (g: { rows: string[] }): number => g.rows.findIndex(r => r.includes('▸'))
    const selTitle = (g: { rows: string[] }): 'alpha' | 'beta' | '' => {
      const i = selRowIndex(g)
      if (i < 0) return ''
      const row = g.rows[i] ?? ''
      return row.includes('Alpha worker') ? 'alpha' : row.includes('Beta idle') ? 'beta' : ''
    }
    const chipUnderSel = (g: { rows: string[] }): string => {
      const i = selRowIndex(g)
      if (i < 0) return ''
      return g.rows[i + 1] ?? ''
    }
    const isChip = (line: string): boolean => /●\s+\d+ workflow/.test(line)
    const alphaFrames = boardFrames.filter(g => selTitle(g) === 'alpha')
    const alphaChip = alphaFrames.filter(g => isChip(chipUnderSel(g)))
    check('C1 the selected row A carries the chip line under it', alphaChip.length > 0, `alpha frames: ${alphaFrames.map(g => `${g.atMs}:${chipUnderSel(g).trim().slice(0, 40)}`).join(' | ') || 'none'}`)
    check('C1 …naming BOTH kinds from the same facts (multi-work)', alphaChip.some(g => /1 workflow · 1 agent running/.test(chipUnderSel(g))), alphaChip.map(g => chipUnderSel(g).trim()).join(' | '))
    const betaFrames = boardFrames.filter(g => selTitle(g) === 'beta')
    check('C2 selecting B (zero work) paints NO chip line', betaFrames.length > 0 && betaFrames.every(g => !isChip(chipUnderSel(g))), `beta frames: ${betaFrames.map(g => `${g.atMs}:${chipUnderSel(g).trim().slice(0, 40)}`).join(' | ') || 'none'}`)
    check('C3 B\'s own row never carries A\'s work', boardFrames.every(g => !(g.rows.find(r => r.includes('Beta idle')) ?? '').includes('workflow')))
    const peekFrames = boardFrames.filter(g => g.atMs >= 19000 && g.atMs <= 21000 && selTitle(g) === 'alpha')
    check('C4 the open peek leads with the chip', peekFrames.some(g => isChip(chipUnderSel(g))), `peek frames: ${peekFrames.map(g => g.atMs).join(',') || 'none'}`)
    const holdFrames = boardFrames.filter(g => g.atMs >= 16000 && g.atMs <= 17000)
    check('C5 the selection holds while the chip updates', holdFrames.length >= 1 && new Set(holdFrames.map(selTitle)).size === 1, holdFrames.map(g => `${g.atMs}:${selTitle(g)}`).join(','))
  } finally {
    run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
  await api.close()
  if (process.env.WORK_CHIP_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\ndrive-work-chip ${SIZE.cols}x${SIZE.rows}: ALL LAWS HOLD` : `\ndrive-work-chip ${SIZE.cols}x${SIZE.rows}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

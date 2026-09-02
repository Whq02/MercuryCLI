#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/drive-work-chip.ts — THE WORK CHIP ON THE REAL
// PRODUCT: the work-chip captures.
//
//  A real daemon (dist) hosts two sessions against the fixture API: A holds
//  the workflows-allowed tag and runs a scripted workflow whose agent
//  replies PACED (the run stays live for the whole drive), then dispatches
//  a background helper on its own model family (paced too) — "1 workflow ·
//  1 agent running"; B runs nothing. The real UI (dist, PTY arena) boots
//  onto the concourse board; the frames are read for:
//   C1  the SELECTED row A carries the chip line under it — amber `●`,
//       the board vocabulary, the counts from the same facts;
//   C2  selecting B (zero work) shows NO chip line (no noise) and the ▸
//       row is B;
//   C3  the chip never leaks: B's row never carries A's work;
//   C4  the open peek (`→` on A) leads with the chip above the ask/mirror;
//   C5  the selection holds while the chip updates (no re-sort).
//  Size: 120x40 by default; MERCURY_WORK_CHIP_SIZE=100x30 reruns the same
//  journey at the small size. MERCURY_WORK_CHIP_CAPTURE_DIR banks frames.
//
// ============================================================================
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

// The workflow script: one phase, one agent on ITS OWN family (sonnet) so
// the fixture paces its reply without racing the main turn's opus rows.
const WORKFLOW_SCRIPT = [
  "export const meta = { name: 'chip-probe', description: 'work-chip drive', phases: [{ title: 'Probe' }] }",
  "phase('Probe')",
  "const a = await agent('reply with the word done and nothing else', { model: 'claude-sonnet-5' })",
  'return { a }',
].join('\n')

// Rows serve in dispatch order under the whenModel gates (gated rows
// outrank catch-alls per matching request): A(opus) 'ready' — awaited
// settled; the grant notice turn launches the Workflow; the workflow's
// agent (sonnet) streams ~60 s; A switches to haiku and the helper turn
// dispatches the Agent whose own reply (haiku, floored or not, takes the
// paced haiku row or a catch-all) streams ~60 s; B's turn takes a
// catch-all. Everything else is spare.
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
      /* not yet */
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
    // Board boots with the composer focused; tab → list at 9 s (the
    // selection lands on the first row), ↓ at 12 s (the other row), ↑ at
    // 15 s (back), `→` at 18 s opens the peek on the selected row, `→` at
    // 22 s closes it. Arrow bytes are spelled as escapes.
    sends: ['9000:\t', '12000:\x1b[B', '15000:\x1b[A', '18000:\x1b[C', '22000:\x1b[C'],
    seconds: 27,
    cols: SIZE.cols,
    rows: SIZE.rows,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work, workB])
      // The Workflow and Agent tools are allowed by rule (the consent road
      // has its own pins) — this drive is about the chip.
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
      // The workflows-allowed tag (the launch-authority law) — its notice
      // turn launches the workflow.
      const grant = (await daemonControlRpc({ op: 'concourseControl', action: 'grant-workflows', sessionId: alphaId, by: 'operator' } as never)) as { ok?: boolean }
      check('the workflows-allowed tag grants', grant.ok === true, JSON.stringify(grant))
      check('alpha\'s workflow is LIVE in its facts', await untilAsync(() => (proj.readSessionFacts(alphaId)?.work ?? []).some(r => r.kind === 'workflow' && r.status === 'running'), 90_000))
      // The helper: A switches to its own family, then the words go in over
      // the connector's send door (the face's own road).
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
    // The chip line: amber ● + the board vocabulary; it sits on the row
    // AFTER the selected (▸) row inside the list band.
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
    // C1: a frame with A selected carries the chip line under it, naming
    // the workflow and the helper agent (multi-work).
    const alphaFrames = boardFrames.filter(g => selTitle(g) === 'alpha')
    const alphaChip = alphaFrames.filter(g => isChip(chipUnderSel(g)))
    check('C1 the selected row A carries the chip line under it', alphaChip.length > 0, `alpha frames: ${alphaFrames.map(g => `${g.atMs}:${chipUnderSel(g).trim().slice(0, 40)}`).join(' | ') || 'none'}`)
    check('C1 …naming BOTH kinds from the same facts (multi-work)', alphaChip.some(g => /1 workflow · 1 agent running/.test(chipUnderSel(g))), alphaChip.map(g => chipUnderSel(g).trim()).join(' | '))
    // C2/C3: B selected — no chip line, and B's row itself never carries
    // A's work.
    const betaFrames = boardFrames.filter(g => selTitle(g) === 'beta')
    check('C2 selecting B (zero work) paints NO chip line', betaFrames.length > 0 && betaFrames.every(g => !isChip(chipUnderSel(g))), `beta frames: ${betaFrames.map(g => `${g.atMs}:${chipUnderSel(g).trim().slice(0, 40)}`).join(' | ') || 'none'}`)
    check('C3 B\'s own row never carries A\'s work', boardFrames.every(g => !(g.rows.find(r => r.includes('Beta idle')) ?? '').includes('workflow')))
    // C4: the open peek (18–22 s, A selected after ↑ at 15 s) leads with the
    // chip line above the mirror rows.
    const peekFrames = boardFrames.filter(g => g.atMs >= 19000 && g.atMs <= 21000 && selTitle(g) === 'alpha')
    check('C4 the open peek leads with the chip', peekFrames.some(g => isChip(chipUnderSel(g))), `peek frames: ${peekFrames.map(g => g.atMs).join(',') || 'none'}`)
    // C5: the selection holds across chip updates (▸ stays on one titled
    // row between the sends).
    const holdFrames = boardFrames.filter(g => g.atMs >= 16000 && g.atMs <= 17000)
    check('C5 the selection holds while the chip updates', holdFrames.length >= 1 && new Set(holdFrames.map(selTitle)).size === 1, holdFrames.map(g => `${g.atMs}:${selTitle(g)}`).join(','))
  } finally {
    run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon?.kill('SIGTERM')
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await api.close()
  if (process.env.WORK_CHIP_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\ndrive-work-chip ${SIZE.cols}x${SIZE.rows}: ALL LAWS HOLD` : `\ndrive-work-chip ${SIZE.cols}x${SIZE.rows}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

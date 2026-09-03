#!/usr/bin/env bun
// ============================================================================
//  prove-live-tiles-drive — the LIVE TILES sheet on the REAL product (the
//  rules are the spec; a line without a capture reads NOT VERIFIED).
//
//  A real daemon (dist) hosts two real sessions against the scripted-stream
//  fixture; the real UI (dist, PTY arena) boots onto the concourse board and
//  the frames are read for the rules:
//   §1/2 LIVE — session A's NOW cell carries its streaming text and the
//        text ADVANCES across frames (the last line, scrolling);
//   §1   the running tool — A's cell reads `running Bash …` while its tool
//        runs;
//   §6   NEEDS-YOU FIRST — session B (a parked rm ask) shows `asks:` in its
//        tile IN THE SAME FRAME as A's streaming text;
//   §5   EXPAND IN PLACE — `→` opens the selected row's live peek inside
//        the list band (the ask banner + transcript rows paint under the
//        row), the board stays the board (no route change), `→` collapses;
//   §9   no lost selection while tiles update;
//   §8   NO NETWORK — a connect tripwire preloaded into the UI child logs
//        every socket target; all of them are loopback/local.
//
//  Size: 120x40 by default (the suite leg); MERCURY_TILES_DRIVE_SIZE=100x30
//  reruns the same journey at the small size (the capture battery drives
//  both and banks the frames).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tiles-drive-')))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const workB = join(SCRATCH, 'work-beta')
for (const d of [daemonDir, work, workB]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const SIZE = process.env.MERCURY_TILES_DRIVE_SIZE === '100x30' ? { cols: 100, rows: 30 } : { cols: 120, rows: 40 }
const KEEP_DIR = process.env.MERCURY_TILES_CAPTURE_DIR

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

// Session A: a long paced stream (the scrolling tile), then a slow Bash
// (the running-tool tile), then a wrap-up stream. Session B: a short
// stream into an rm tool call the scratch home's ask rule PARKS (the
// needs-you tile). Turn order = request order: A's opener, B's opener,
// A's continuation after its tool result.
const alphaTokens = Array.from({ length: 40 }, (_, i) => `tile-alpha ${String(i + 1).padStart(3, '0')} `)
const api = await startFixtureApi([
  { kind: 'paced_tool_use', preDeltas: alphaTokens, gapMs: 700, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo alpha-done', description: 'a long pause' } }] },
  { kind: 'paced_tool_use', preDeltas: ['tile-beta prelude one. ', 'tile-beta prelude two. '], gapMs: 250, tools: [{ name: 'Bash', input: { command: 'rm -rf scratchling', description: 'cleanup' } }] },
  { kind: 'paced', deltas: Array.from({ length: 12 }, (_, i) => `tile-alpha wrap ${String(i + 1).padStart(2, '0')} `), gapMs: 500, settleDelayMs: 2000 },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

// §8: the connect tripwire — preloaded into the UI child; every socket
// target lands in the log, and the assert requires all of them local.
const tripwireLog = join(SCRATCH, 'connects.log')
writeFileSync(tripwireLog, '')
const tripwirePath = join(SCRATCH, 'tripwire.cjs')
writeFileSync(
  tripwirePath,
  [
    "const net = require('node:net')",
    "const fs = require('node:fs')",
    'const log = process.env.MERCURY_TRIPWIRE_LOG',
    'const t0 = Date.now()',
    'const orig = net.Socket.prototype.connect',
    'net.Socket.prototype.connect = function (...args) {',
    '  try {',
    '    let o = args[0]',
    '    if (Array.isArray(o)) o = o[0]',
    "    let host = ''",
    "    let port = ''",
    "    if (o !== null && typeof o === 'object') {",
    "      host = String(o.host ?? o.path ?? '')",
    "      port = String(o.port ?? '')",
    '    } else {',
    '      port = String(o)',
    "      host = typeof args[1] === 'string' ? args[1] : ''",
    '    }',
    '    if (log) fs.appendFileSync(log, (Date.now() - t0) + ":" + host + ":" + port + "\\n")',
    '  } catch {}',
    '  return orig.apply(this, args)',
    '}',
  ].join('\n'),
)

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
// The board shows TILES only for sessions of its own project: a session of
// another project is an OTHER PROJECTS door line ("1 running in …work ·
// switch to see them"), never a row with a NOW cell. Both sessions are
// dispatched into the arena's own cwd — the project the board boots in.
const spawnDaemonWithHome = (configHome: string, projectDir: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', projectDir], {
    cwd: projectDir,
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
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
const obligations = await import('../../src/services/crew/obligations.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

let alphaId = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    // Board boots with the composer focused; tab → list at 11 s (mid-A
    // stream), `→` opens the selected row's peek at 13 s, closes it at 18 s.
    // Arrow bytes are spelled as escapes (the estate's chord law).
    sends: ['11000:\t', '13000:\x1b[C', '18000:\x1b[C'],
    seconds: 34,
    cols: SIZE.cols,
    rows: SIZE.rows,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work, workB])
      // Two sessions in one folder need git (the second forks a worktree of
      // its own — the daemon holds it "no-repository" otherwise): the arena's
      // cwd is a repository with one commit before either dispatch.
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd })
      spawnSync('git', ['-c', 'user.name=tiles', '-c', 'user.email=tiles@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd })
      // The ask rule that PARKS session B's rm (a genuine permission ask).
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(rm:*)'] } }))
      spawnDaemonWithHome(configDir, cwd)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'tiles-alpha-1',
        prompt: 'stream a long alpha body',
        workspaceDir: cwd,
        title: 'Alpha stream',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('alpha dispatched', a.ok === true && a.sessionId !== undefined, JSON.stringify(a))
      alphaId = a.sessionId ?? ''
      const alphaTranscript = join(paths.getProjectDir(cwd), `${alphaId}.jsonl`)
      check('alpha transcript born', await untilAsync(async () => existsSync(alphaTranscript) && statSync(alphaTranscript).size > 100, 30_000))
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'tiles-beta-1',
        prompt: 'try a cleanup',
        workspaceDir: cwd,
        title: 'Beta asker',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('beta dispatched', b.ok === true && b.sessionId !== undefined, JSON.stringify(b))
      const bid = b.sessionId ?? ''
      check(
        'beta parked a REAL permission ask',
        await untilAsync(async () => (await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === bid && (o.ref ?? '').startsWith('permission:')), 40_000),
      )
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
      NODE_OPTIONS: `--require ${tripwirePath}`,
      MERCURY_TRIPWIRE_LOG: tripwireLog,
    },
  })
  try {
    const offsets = [4000, 6000, 8000, 10000, 12000, 14000, 16000, 17000, 19000, 21000, 23000, 25000, 27000, 30000, 33000].map(m => S(m))
    const grabs = grabScreens(run, SIZE.cols, SIZE.rows, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    if (KEEP_DIR) {
      mkdirSync(KEEP_DIR, { recursive: true })
      for (const g of grabs) {
        writeFileSync(join(KEEP_DIR, `drive-${SIZE.cols}x${SIZE.rows}-at${g.atMs}.txt`), g.rows.map(r => r.replace(/\s+$/, '')).join('\n'))
      }
    }
    const boardFrames = grabs.filter(g => text(g).includes('SESSIONS'))
    check('the board painted', boardFrames.length > 0, `frames: ${boardFrames.map(g => g.atMs).join(',')}`)
    // §1/2 LIVE: Alpha's ROW carries its streaming text, and the text
    // ADVANCES frame to frame (the scrolling last line).
    const alphaRowText = (g: { rows: string[] }): string => g.rows.find(r => r.includes('Alpha stream')) ?? ''
    const streamFrames = boardFrames.filter(g => /tile-alpha (\d{3})/.test(alphaRowText(g)) && !/running/.test(alphaRowText(g)))
    check('§1 the NOW cell streams (tile text in Alpha row)', streamFrames.length >= 2, `frames: ${streamFrames.map(g => g.atMs).join(',') || 'none'}`)
    const tokenOf = (g: { rows: string[] }): number => Math.max(-1, ...[...alphaRowText(g).matchAll(/tile-alpha (\d{3})/g)].map(m => Number(m[1])))
    const toks = streamFrames.map(tokenOf)
    check('§2 …and the line SCROLLS (later frames carry later tokens)', toks.length >= 2 && toks[toks.length - 1]! > toks[0]!, `tokens: ${toks.join(',')}`)
    // §1 the running tool.
    const toolFrames = boardFrames.filter(g => /running Bash/.test(alphaRowText(g)))
    check('§1 the running-tool tile (`running Bash …`)', toolFrames.length > 0, `frames: ${toolFrames.map(g => g.atMs).join(',') || 'none'}`)
    // §6 the ask leads ITS tile in the same frame as Alpha's live activity.
    // The BOARD row carries the unquoted title (the rail quotes it) — the
    // matcher must not read the rail's own copy.
    // The row's state word stands between the glyph and the title ("◆ NEEDS
    // YOU Beta asker"); the tile follows the title.
    const betaBoardRow = (g: { rows: string[] }): string => g.rows.find(r => /◆ (NEEDS YOU )?Beta asker\s{2,}/.test(r)) ?? ''
    const askAndStream = boardFrames.filter(g => /asks:/.test(betaBoardRow(g)) && /tile-alpha|running Bash/.test(alphaRowText(g)))
    check('§6 needs-you shows FIRST beside a streaming tile', askAndStream.length > 0, `frames: ${askAndStream.map(g => g.atMs).join(',') || 'none'}`)
    // §5 the peek is the MIRROR: the live-view pane below the list shows the
    // selected row's chat (the ask and its transcript rows) while the list
    // band keeps its rows and the board stays the board — the in-band peek
    // that displaced the rows is retired with the live pane's own box.
    const listBandRows = (g: { rows: string[] }): string[] => {
      const start = g.rows.findIndex(r => r.includes('STATUS & TITLE'))
      if (start < 0) return []
      const rest = g.rows.slice(start + 1)
      const end = rest.findIndex(r => /╰/.test(r))
      return rest.slice(0, end < 0 ? undefined : end)
    }
    const mirrorRows = (g: { rows: string[] }): string[] => {
      const start = g.rows.findIndex(r => r.includes('STATUS & TITLE'))
      if (start < 0) return []
      const rest = g.rows.slice(start + 1)
      const end = rest.findIndex(r => /╰/.test(r))
      return end < 0 ? [] : rest.slice(end + 1)
    }
    const bandText = (g: { rows: string[] }): string => listBandRows(g).join('\n')
    const mirrorText = (g: { rows: string[] }): string => mirrorRows(g).join('\n')
    const peekFrames = grabs.filter(g => g.atMs >= 14000 && g.atMs <= 17000 && text(g).includes('SESSIONS'))
    // The mirror body is sticky-tail: at small grants the visible rows are
    // the NEWEST (the running-bash card), so any of the session's own
    // transcript needles counts as body evidence.
    const bodyNeedle = (t: string): boolean => /tile-beta prelude|try a cleanup|rm -rf scratchling|Running 1 bash/.test(t)
    const opened = peekFrames.filter(g => bodyNeedle(mirrorText(g)) && /asks:/.test(bandText(g)) && /Beta asker/.test(mirrorText(g)))
    check("§5 the selected row's chat paints in the mirror below the list (the ask on its row, the transcript rows in the pane)", opened.length > 0, `frames: ${opened.map(g => g.atMs).join(',') || 'none'}`)
    check('§5 the peek is not a hop (the board frame stays)', opened.every(g => text(g).includes('SESSIONS')))
    check('§5 the list band keeps its rows under the mirror (nothing displaced)', opened.every(g => /Alpha stream/.test(bandText(g)) && /Beta asker/.test(bandText(g))))
    // §9 the selection survives tile updates: the ▸ marker sits on the same
    // titled row across two streaming frames after the tab.
    const selTitle = (g: { rows: string[] }): string => {
      const row = g.rows.find(r => r.includes('▸'))
      if (row === undefined) return ''
      return row.includes('Alpha stream') ? 'alpha' : row.includes('Beta asker') ? 'beta' : row.trim().slice(0, 24)
    }
    const postTab = boardFrames.filter(g => g.atMs >= 12000 && selTitle(g) !== '')
    check('§9 selection holds while tiles update', postTab.length >= 2 && new Set(postTab.map(selTitle)).size === 1, `selections: ${postTab.map(g => `${g.atMs}:${selTitle(g)}`).join(',')}`)
    // §8 the tripwire (the wording: zero outbound from the
    // board's MOUNT onward): every connect is timestamped from the UI
    // child's start. The base product's own boot-reach (an update/roles
    // fetch class toward api.anthropic.com, present with tiles absent —
    // the A/B battery pins that set) lands in the first seconds; the board
    // then runs ~25 s of streaming, tool and peek activity with ZERO
    // non-local connects.
    const entries = readFileSync(tripwireLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const parts = l.split(':')
        return { ms: Number(parts[0]), host: parts[1] ?? '', port: parts[2] ?? '' }
      })
    const nonLocal = entries.filter(e => {
      if (e.host === '' || e.host === '127.0.0.1' || e.host === 'localhost' || e.host === '::1') return false
      if (e.host.startsWith('/') || e.host === '') return false // unix sockets (daemon control)
      return true
    })
    const MOUNT_BOUND_MS = 8000
    const postMount = nonLocal.filter(e => e.ms > MOUNT_BOUND_MS)
    check('§8 zero outbound from the mount onward', postMount.length === 0, postMount.slice(0, 5).map(e => `${e.ms}ms ${e.host}:${e.port}`).join(' | ') || `${entries.length} connects, ${nonLocal.length} boot-reach`)
    check('§8 the tripwire saw the wire at all (poison guard)', entries.length > 0, `${entries.length} connects logged`)
    console.log(`  [info] boot-reach (pre-mount) targets: ${[...new Set(nonLocal.map(e => `${e.host}:${e.port}`))].join(', ') || 'none'}`)
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
  await api.close()
  if (process.env.TILES_DRIVE_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nprove-live-tiles-drive ${SIZE.cols}x${SIZE.rows}: ALL LAWS HOLD` : `\nprove-live-tiles-drive ${SIZE.cols}x${SIZE.rows}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

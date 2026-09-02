#!/usr/bin/env bun
// ============================================================================
//  prove-command-privacy-drive — THE COMMAND-PRIVACY LAW on the real product
//  (the exact leaked journey): inside a
//  HOPPED managed session mid-turn, `/note <words>` writes the notepad and
//  the model never sees a byte — no transcript row, no wire request, no
//  queued steering, no turn; `/crew` paints its roster as display rows the
//  same way; and `/halt` (stop-class) INTERRUPTS the running turn instead
//  of queueing behind it, with its receipt painted and nothing persisted.
//  Poison = the pre-fix leak: the line queued as steering, executed on the
//  runner, and persisted as a user row every later turn would carry to the
//  wire.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'cmd-privacy-drive-'))
const daemonDir = join(SCRATCH, 'daemon')
const tabulaDir = join(SCRATCH, 'tabula')
const work = join(SCRATCH, 'work-alpha')
for (const d of [daemonDir, tabulaDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

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
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const countingTurn = (n: number) => ({
  kind: 'paced_tool_use' as const,
  preDeltas: [`counting ${String(n).padStart(3, '0')} `, 'still going '],
  gapMs: 500,
  tools: [{ name: 'Bash', input: { command: `sleep 4; echo tick-${n}`, description: 'one counted beat' } }],
  whenModel: 'opus',
})
const api = await startFixtureApi([
  ...Array.from({ length: 16 }, (_, i) => countingTurn(i + 1)),
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemon = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn('node', [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TABULA_DIR: tabulaDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}
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

let alphaId = ''
let arenaCwd = ''
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  // The hop ladder is observed-ready off the session title painting on the
  // board; the typed journey is the operator's exact one: hop in mid-turn,
  // /note, /crew, back to the board.
  sends: [
    'after:Alpha count:2500:\t',
    'after:Alpha count:4000:\r',
    'after:Alpha count:5200:\r',
    'after:Alpha count:9000:/note remember the milk',
    'after:Alpha count:10500:\r',
    'after:Alpha count:14000:/crew',
    'after:Alpha count:15500:\r',
    'after:Alpha count:20000:/concourse',
    'after:Alpha count:21500:\r',
  ],
  seconds: 42,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, _cwd) => {
    arenaCwd = _cwd
    seedFirstRun(configDir, [_cwd, work])
    spawnDaemon(configDir)
    check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'privdrive-alpha',
      prompt: 'count slowly with sleeps',
      workspaceDir: _cwd,
      title: 'Alpha count',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('alpha dispatched', a.ok === true, JSON.stringify(a))
    alphaId = a.sessionId ?? ''
    const alphaTranscript = join(paths.getProjectDir(_cwd), `${alphaId}.jsonl`)
    check('alpha transcript born', await untilAsync(() => existsSync(alphaTranscript) && statSync(alphaTranscript).size > 100, 30_000))
  },
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_TABULA_DIR: tabulaDir,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_CACHE_CLOCK: '0',
  },
})
try {
  const grabs = grabScreens(run, 120, 40, [8000, 12000, 14000, 17000, 24000, 32000, 40000].map(m => S(m)))
  const KEEP_DIR = process.env.MERCURY_PRIVACY_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    for (const g of grabs) {
      writeFileSync(join(KEEP_DIR, `at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n'))
    }
  }
  const text = (g: { rows: string[] }): string => g.rows.join('\n')

  // §1 — the notepad: the note landed in the SCREEN project's estate.
  const projDirs = existsSync(tabulaDir) ? readdirSync(tabulaDir) : []
  const journalOf = (d: string): string => {
    const p = join(tabulaDir, d, 'journal.jsonl')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  const holders = projDirs.filter(d => journalOf(d).includes('remember the milk'))
  check('§1 the note EXECUTED into the notepad estate', holders.length === 1, `holders: ${holders.join(',') || 'none'}`)
  check(
    "§1 …keyed by the SCREEN's project (the arena cwd), not the worker's workspace",
    holders.every(h => h.includes('flux-arena-cwd')) && !holders.some(h => h.includes('work-alpha')),
    holders.join(','),
  )

  // §2 — the transcript never carries the lines (the leak's poison).
  const transcriptPath = join(paths.getProjectDir(arenaCwd), `${alphaId}.jsonl`)
  const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : ''
  check('§2 the session transcript exists and carries the counting turn', transcript.includes('counting'), transcriptPath)
  check('§2 NO transcript byte carries the /note line (poison: the persisted user row)', !transcript.includes('/note') && !transcript.includes('remember the milk') && !transcript.includes('command-message>note'), '')
  check('§2 NO transcript byte carries the /crew line', !transcript.includes('/crew') && !transcript.includes('command-message>crew'), '')

  // §3 — the wire never saw the lines (no request, no token).
  const wireHits = api.requests.filter((r: { raw: string }) => r.raw.includes('/note') || r.raw.includes('remember the milk') || r.raw.includes('/crew')).length
  check('§3 the wire saw NO request carrying either line', wireHits === 0, `${wireHits} of ${api.requests.length}`)

  // §4 — the receipts painted on the focused chat (display rows / toast),
  // and the steering queue never took the line (poison: '⤳ steering — 1
  // folds in' + the queued /note row from the pre-fix drive).
  const chatFrames = grabs.filter(g => g.atMs >= 12000 && g.atMs <= 17000)
  check('§4 the /note receipt painted (Captured …)', chatFrames.some(g => /Captured/.test(text(g))), chatFrames.map(g => String(g.atMs)).join(','))
  const crewFrames = grabs.filter(g => g.atMs >= 15000 && g.atMs <= 24000)
  // The /crew receipt's fingerprint on screen: the directory footer
  // ('sources: identity …') on a populated estate, or the empty-state
  // sentence on a fresh one — either way the ROSTER answered in the chat.
  check(
    '§4 the /crew directory painted as the chat receipt',
    crewFrames.some(g => /sources: identity|the crew directory is empty/.test(text(g))),
    crewFrames.map(g => String(g.atMs)).join(','),
  )
  // The poison, spelled at the strip's own vocabulary: the steering queue
  // taking the line is a COUNTED entry — '⤳ steering — N folds in…' or an
  // 'N waits for the next turn' — standing beside the note's text. The
  // strip's empty-draft ADVERTISEMENT ('↵ folds in at the next step') is a
  // claim about a future plain prompt, and it lawfully co-exists with the
  // sidebar's own '/note' hint ('✧ no notes — /note') and the executed
  // display row's echo — the old frame-level /note/ co-occurrence matched
  // exactly those two truths (adjudicated on the kept frames: no counted
  // steer, no queued row, the Captured receipt right after the ↵ — the
  // command executed privately and immediately, mid-turn).
  check('§4 the steering queue NEVER took the line (no counted steer or next-turn hold carries the note)', !grabs.some(g => (/\d+ folds? in at the next step/.test(text(g)) || /\d+ waits? for the next turn/.test(text(g))) && /remember the milk/.test(text(g))), '')
} finally {
  run.cleanup()
}

try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
  /* down */
}
daemon?.kill('SIGTERM')
await api.close()

// ── leg 2: /halt is a BRAKE — interrupt-first, mid-turn, zero rows ─────────
console.log('leg 2 — /halt mid-turn interrupts the running turn (never queues behind it)')
{
  const daemonDir2 = join(SCRATCH, 'daemon2')
  const work2 = join(SCRATCH, 'work-halt')
  for (const d of [daemonDir2, work2]) mkdirSync(d, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir2
  const api2 = await startFixtureApi([
    ...Array.from({ length: 12 }, (_, i) => countingTurn(i + 1)),
    { kind: 'text', text: 'Spare.' },
  ])
  let daemon2: ReturnType<typeof spawn> | null = null
  let halted = ''
  let arenaCwd2 = ''
  const run2 = await runArtifactArena({
    turns: [],
    sends: [
      'after:Halt target:2500:\t',
      'after:Halt target:4000:\r',
      'after:Halt target:5200:\r',
      'after:Halt target:9000:/halt',
      'after:Halt target:10500:\r',
    ],
    seconds: 30,
    cols: 120,
    rows: 40,
    keep: true,
    seedHome: async (configDir, _cwd) => {
      arenaCwd2 = _cwd
      seedFirstRun(configDir, [_cwd, work2])
      process.env.MERCURY_CONFIG_DIR = configDir
      const fd2 = openSync(join(SCRATCH, 'daemon2.log'), 'a')
      daemon2 = spawn('node', [DIST, 'daemon', 'run', work2], {
        cwd: work2,
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: configDir,
          MERCURY_DAEMON_DIR: daemonDir2,
          MERCURY_TABULA_DIR: tabulaDir,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          ANTHROPIC_BASE_URL: api2.url,
          MERCURY_CACHE_CLOCK: '0',
          MERCURY_PARTY: '0',
        },
        stdio: ['ignore', fd2, fd2],
      })
      check('daemon2 serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const h = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'privdrive-halt',
        prompt: 'count slowly with sleeps',
        workspaceDir: _cwd,
        title: 'Halt target',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('halt target dispatched', h.ok === true, JSON.stringify(h))
      halted = h.sessionId ?? ''
      const ht = join(paths.getProjectDir(_cwd), `${halted}.jsonl`)
      check('halt-target transcript born', await untilAsync(() => existsSync(ht) && statSync(ht).size > 100, 30_000))
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir2,
      MERCURY_TABULA_DIR: tabulaDir,
      ANTHROPIC_BASE_URL: api2.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const grabs2 = grabScreens(run2, 120, 40, [8000, 13000, 16000, 22000, 28000].map(m => S(m)))
    const KEEP_DIR = process.env.MERCURY_PRIVACY_CAPTURE_DIR
    if (KEEP_DIR) {
      const { writeFileSync } = await import('node:fs')
      for (const g of grabs2) {
        writeFileSync(join(KEEP_DIR, `halt-at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n'))
      }
    }
    const text2 = (g: { rows: string[] }): string => g.rows.join('\n')
    const receiptFrames = grabs2.filter(g => g.atMs >= 12000 && /Hard stop/.test(text2(g)))
    check('§5 the /halt receipt painted (⊘ Hard stop …)', receiptFrames.length >= 1, grabs2.map(g => String(g.atMs)).join(','))
    // Interrupt-first: the turn stops — a late frame no longer paints the
    // running-tool/replying strip for the halted session.
    const lateFrames = grabs2.filter(g => g.atMs >= 16000)
    check(
      '§5 the running turn INTERRUPTED (no replying/running strip after the brake)',
      lateFrames.length > 0 && lateFrames.every(g => !/replying — your words land|running a tool — your words land/.test(text2(g))),
      lateFrames.map(g => String(g.atMs)).join(','),
    )
    const ht = join(paths.getProjectDir(arenaCwd2), `${halted}.jsonl`)
    const t2 = existsSync(ht) ? readFileSync(ht, 'utf8') : ''
    check('§5 NO transcript byte carries the /halt line (poison: the queued user row + the 6m jellyfish)', t2 !== '' && !t2.includes('/halt') && !t2.includes('command-message>halt'), '')
    const wire2 = api2.requests.filter((r: { raw: string }) => r.raw.includes('/halt')).length
    check('§5 the wire never saw /halt', wire2 === 0, String(wire2))
  } finally {
    run2.cleanup()
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* the halt already took it down — exactly its contract */
  }
  ;(daemon2 as ReturnType<typeof spawn> | null)?.kill('SIGTERM')
  await api2.close()
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log(failures === 0 ? '\nprove-command-privacy-drive: ALL LAWS HOLD' : `\nprove-command-privacy-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  prove-esc-clears-draft — DOUBLE-ESC CLEARS THE COMPOSER (ruled):
//  esc·esc inside the 3-second window
//  wipes the composer's draft; esc · a wait past the window · esc leaves it
//  intact. Driven on the built bundle (PTY arena) on the ONE composer over
//  a hopped IDLE managed session — the seat where esc has nothing else to
//  do, exactly the ruled arm ("the first esc had nothing else to do"; a
//  busy turn's esc is the interrupt, an overlay's esc closes it — both
//  respected, both pinned elsewhere). 120x40 and 100x30.
//  Poison = the pre-fix 800 ms blink: an operator-paced esc·esc (≈2 s
//  apart) read as a no-op.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const { runArtifactArena, grabScreens, sendStamp } = await import('../streaming/artifactArena.ts')
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

const DRAFT = 'hello draft mercury'

// One leg: an IDLE hopped session (its one scripted turn settles fast);
// type the draft, esc·esc at `gapMs`, read the frames.
const leg = async (tag: string, cols: number, rows: number, gapMs: number): Promise<void> => {
  const SCRATCH = mkdtempSync(join(tmpdir(), `escdraft-${tag}-`))
  const daemonDir = join(SCRATCH, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CONCOURSE = 'always'
  const api = await startFixtureApi([
    { kind: 'text', text: 'Settled and quiet.', whenModel: 'opus' },
    { kind: 'text', text: 'Spare.' },
  ])
  const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
  let daemon: ReturnType<typeof spawn> | null = null
  // The ladder anchors each step on the SCREEN STATE it needs: the board's
  // row for the hop; the chat's own idle placeholder for the typing and the
  // esc pair. All three late sends share ONE arm point ('Type a prompt'
  // first paints in the hopped chat), so the esc·esc gap is exact — a
  // single shared board needle bunched overdue sends into one burst and
  // collapsed the ruled window.
  const escAt = 4_500
  const run = await runArtifactArena({
    turns: [],
    sends: [
      // The board row wears the dispatch's TITLE: the supervisor keeps
      // req.title on the worker record, the list row prints it, and the
      // title mint fills empty titles only — anchor the hop on the words
      // the row actually paints. The board opens on the coordinator: tab
      // reaches the list, the first ↵ ARMS the row (its line reads
      // "armed — ↵ again enters") and the second ↵ enters — the second
      // press rides the arm's own receipt, never a guessed delay.
      'after:Quiet seat:2500:\t',
      'after:Quiet seat:4000:\r',
      'after:↵ again enters:800:\r',
      `after:Type a prompt:1500:${DRAFT}`,
      `after:Type a prompt:${escAt}:\x1b`,
      `after:Type a prompt:${escAt + gapMs}:\x1b`,
    ],
    seconds: Math.ceil((escAt + gapMs + 20_000) / 1000),
    cols,
    rows,
    keep: true,
    seedHome: async (configDir, ground) => {
      // The board is project-scoped: its rows are the ground's own sessions,
      // and the ground is the cwd the chat boots in. The daemon runs there
      // and the seat is dispatched there, so the row is the board's own; a
      // git ground keeps the folder's git-init card off the board.
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: ground })
      spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@x', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: ground })
      seedFirstRun(configDir, [ground])
      process.env.MERCURY_CONFIG_DIR = configDir
      daemon = spawn('node', [DIST, 'daemon', 'run', ground], {
        cwd: ground,
        env: { ...process.env, MERCURY_CONFIG_DIR: configDir, MERCURY_DAEMON_DIR: daemonDir, ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url, MERCURY_CACHE_CLOCK: '0' },
        stdio: ['ignore', logFd, logFd],
      })
      check(`${tag}: the daemon serves`, await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: `escdraft-${tag}`,
        prompt: 'say something settled',
        workspaceDir: ground,
        title: 'Quiet seat',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check(`${tag}: dispatched`, a.ok === true, JSON.stringify(a))
      const t = join(paths.getProjectDir(ground), `${a.sessionId ?? ''}.jsonl`)
      check(`${tag}: transcript born`, await untilAsync(() => existsSync(t) && statSync(t).size > 100, 30_000))
    },
    extraEnv: { MERCURY_CONCOURSE: 'always', MERCURY_DAEMON_DIR: daemonDir, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_CACHE_CLOCK: '0' },
  })
  try {
    // The sends are OBSERVED-READY (needle-anchored), so the assert clock is
    // the SEND LOG's fire times in the grab's own stamp base (sendStamp) —
    // a raw first-output offset against a re-based journey adjudicates the
    // wrong frames by the whole anchor shift.
    const escSends = run.sendLog
      .filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x1b')
      .map(s => sendStamp(run, s))
      .sort((a, b) => a - b)
    const draftSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === DRAFT)
    check(`${tag}: the journey ran whole (draft + two escs sent)`, escSends.length === 2 && draftSend !== undefined, `escs at ${escSends.join(',')}`)
    const [esc1Ms, esc2Ms] = [escSends[0] ?? 0, escSends[1] ?? 0]
    const grabs = grabScreens(run, cols, rows, [Math.max(0, esc1Ms - 500), Math.max(0, esc2Ms - 500), esc2Ms + 700, esc2Ms + 2000, esc2Ms + 4000])
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const before = grabs[0]
    check(`${tag}: the draft was TYPED into the composer`, before !== undefined && text(before).includes(DRAFT), '')
    const between = grabs[1]
    check(`${tag}: the FIRST esc alone never clears (draft intact between the escs)`, between !== undefined && text(between).includes(DRAFT), '')
    const after = grabs.slice(2)
    if (gapMs <= 3000) {
      check(`${tag}: esc·esc inside 3 s CLEARS the draft (poison: the no-op / the 800 ms blink)`, after.length > 0 && after.every(g => !text(g).includes(DRAFT)), after.map(g => `${g.atMs}:${text(g).includes(DRAFT)}`).join(' '))
      check(`${tag}: the receipt says so (draft cleared)`, after.some(g => /draft cleared/.test(text(g))) || grabs.some(g => /draft cleared/.test(text(g))), '')
    } else {
      check(`${tag}: esc · past the window · esc leaves the draft INTACT`, after.length > 0 && after.every(g => text(g).includes(DRAFT)), after.map(g => `${g.atMs}:${text(g).includes(DRAFT)}`).join(' '))
    }
  } finally {
    run.cleanup()
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* down */
  }
  ;(daemon as ReturnType<typeof spawn> | null)?.kill('SIGTERM')
  await api.close()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log('leg 1 — 120x40, esc·esc 2 s apart (inside the ruled window) clears')
await leg('quick-120', 120, 40, 2000)
console.log('leg 2 — 120x40, esc · 4.5 s · esc keeps the draft')
await leg('slow-120', 120, 40, 4500)
console.log('leg 3 — 100x30, esc·esc 2 s apart clears')
await leg('quick-100', 100, 30, 2000)

console.log(failures === 0 ? '\nprove-esc-clears-draft: ALL LAWS HOLD' : `\nprove-esc-clears-draft: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

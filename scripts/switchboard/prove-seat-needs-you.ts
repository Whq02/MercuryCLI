#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-seat-needs-you.ts — the needs-you rule
//  (the FULL consent card in a hopped-into session) and the composer
//  door, on the REAL product. (Lineage: the concourse fold's needs-you
//  journey, evolved to the seat — every law kept, the compact y/n line
//  replaced by the same consent card the session started at boot gets.)
//
//  A board session raises a GENUINE permission ask: an ask rule in the
//  scratch home's settings (Bash(rm:*)) keeps the matched ask with the
//  human — flow's floor 3 — and the daemon child's stdio prompt tool carries
//  it out as a can_use_tool control_request; the daemon parks it, mints the
//  needs-you obligation and publishes the ask's FULL payload. The operator
//  sees it on the board's rail (as today), hops into the session, sees the
//  SAME consent card the boot session would show, presses ↵ on Yes — the
//  daemon routes the full answer into the child, the tool runs, the reply
//  lands. Then the operator types into the focused chat: the words deliver
//  through the daemon and the session answers them.
//   N1  the board shows the ask on its NEEDS YOU rail (as today);
//   N2  entering shows the FULL consent card (the tool, the command, the
//       choices, the amend/explain keys) in the bottom column below the
//       session's transcript;
//   N3  ↵ on Yes answers it through the daemon: the obligation settles, the
//       child runs the tool and its next reply lands in the session's file;
//   N4  typed words deliver to the session: the dispatch ledger carries the
//       instruction, the session's file gains the user row and the reply.
//  Fixture-hermetic: scratch home + daemon dir + workspace.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'seat-needs-you-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const COLS = Number(process.env.SWITCH_COLS ?? '120')
const ROWS = Number(process.env.SWITCH_ROWS ?? '40')

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
seedFirstRun(home, [work])
const askRule = { permissions: { ask: ['Bash(rm:*)'] } }

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'tool_use', whenModel: 'opus', name: 'Bash', input: { command: `rm -f ${join(SCRATCH, 'nothing-here')}`, description: 'tidy' }, preText: 'about to tidy up. ' },
  { kind: 'text', whenModel: 'opus', text: 'Tidied after your allow.' },
  { kind: 'text', whenModel: 'opus', text: 'hi back — the words landed.' },
  { kind: 'text', whenModel: 'opus', text: 'Spare.' },
  { kind: 'text', whenModel: 'opus', text: 'Spare.' },
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
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const obligations = await import('../../src/services/crew/obligations.ts')
let sid = ''
let log = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const N = 'Tidy probe'
  const WORDS = 'say hi from the focused chat'
  const run = await runArtifactArena({
    turns: [],
    sends: [
      `after:${N}:900:\t`, // focus the list (the one row)
      `after:${N}:1500:\r`, // ARM — the ruled L17 grammar: the first ↵ arms the row
      `after:${N}:2100:\r`, // ENTER — the hop: the session becomes the focused chat
      `after:${N}:5500:\r`, // ↵ on "Yes" — the full consent card answers from inside the session
      `after:${N}:12500:${WORDS}`, // words into the focused chat
      `after:${N}:13300:\r`, // ↵ — they deliver through the daemon
    ],
    seconds: 30,
    cols: COLS,
    rows: ROWS,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      // The ask rule is operator-reachable machinery in the arena's home —
      // the daemon child inherits the home and reads it like any settings.
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify(askRule))
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const d = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'seat-needs-you',
        prompt: 'tidy the scratch folder',
        // The ARENA'S OWN project (the ratified project-scoped board): the
        // journey proves its own law on same-project rows; the cross-project
        // DOOR is prove-cross-project's estate.
        workspaceDir: cwd,
        title: N,
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('the session dispatched', d.ok === true && d.sessionId !== undefined, JSON.stringify(d))
      sid = d.sessionId ?? ''
      log = join(paths.getProjectDir(cwd), `${sid}.jsonl`)
      check(
        'the session raised a REAL permission ask (an obligation in the switchboard scope)',
        await untilAsync(async () => (await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sid && (o.ref ?? '').startsWith('permission:')), 40_000),
      )
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const offsets = Array.from({ length: 27 }, (_, i) => S(2000 + i * 1000))
    const grabs = grabScreens(run, COLS, ROWS, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const boardWithAsk = grabs.filter(g => text(g).includes('SESSION CONCOURSE') && text(g).includes('NEEDS YOU'))
    check('N1 the board shows the ask on its NEEDS YOU rail (as today)', boardWithAsk.length > 0, `frames: ${boardWithAsk.map(g => g.atMs).join(',') || 'none'}`)
    // A focused hopped-into session is told by ITS OWN chat (the session's
    // prompt or reply), its status row, or its consent card — at 30 rows a
    // tall card can scroll the transcript out entirely, and the card IS the
    // session's; the board is told by its header.
    const hoppedFrames = grabs.filter(
      g =>
        !text(g).includes('SESSION CONCOURSE') &&
        (text(g).includes('tidy the scratch folder') ||
          text(g).includes('about to tidy up') ||
          text(g).includes('⇧← back') ||
          text(g).includes('Do you want to proceed?')),
    )
    // The FULL consent card: the tool's card (its command, its note), the
    // proceed question, the numbered choices, the amend/explain keys — the
    // same card the session started at boot shows for the same ask.
    const cardFrames = hoppedFrames.filter(
      g => text(g).includes('Bash command') && text(g).includes('Do you want to proceed?') && text(g).includes('rm -f'),
    )
    check(
      'N2 entering shows the FULL consent card — the tool, the command, the choices, the amend/explain keys',
      cardFrames.some(g => /1\. Yes/.test(text(g)) && /2\. No/.test(text(g)) && text(g).includes('tab amend')),
      `hopped frames: ${hoppedFrames.map(g => g.atMs).join(',') || 'none'}; with the card: ${cardFrames.map(g => g.atMs).join(',') || 'none'}`,
    )
    // Parity with the boot session's card for the SAME ask (the line-3
    // control drive): the card explains the matched rule and names where
    // rules change — the structured reason crossed the doorway.
    check(
      'N2 …and the card explains the ask as the boot session\'s card does (the rule Bash(rm:*) + the /permissions hint)',
      cardFrames.some(
        g =>
          /The rule Bash\(rm:\*\) requires confirmation for this command/.test(text(g)) &&
          text(g).includes('Permission rules can be changed in /permissions'),
      ),
    )
    // The card sits where the boot session's own card does — the bottom
    // column: below the transcript when the transcript shares the frame,
    // and never pinned to the top (a short terminal may scroll the
    // transcript out entirely; the card still owns the bottom column).
    const cardBelowTranscript = cardFrames.some(g => {
      const rows = g.rows
      const cardRow = rows.findIndex(r => r.includes('Bash command'))
      const transcriptRow = rows.findIndex(r => r.includes('about to tidy up'))
      return cardRow > 3 && (transcriptRow === -1 || transcriptRow < cardRow)
    })
    check('N2 …where the consent card sits: the bottom column (below the transcript when it shares the frame)', cardBelowTranscript)
    check('N3 ↵ on Yes settles the obligation through the daemon', await untilAsync(async () => !(await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sid), 10_000))
    const logText = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    check('N3 the child ran the tool and its reply landed in the session\'s file', await untilAsync(async () => logText().includes('Tidied after your allow.'), 20_000))
    const answered = hoppedFrames.filter(g => text(g).includes('Tidied after your allow.'))
    check('N3 the reply painted inside the focused chat', answered.length > 0, `frames: ${answered.map(g => g.atMs).join(',') || 'none'}`)
    // N4: the words delivered. THE ONE IDENTITY: the focused chat's
    // connector mints a bare uuid as the clientMessageId and it rides the
    // dispatch as the frame uuid, the queue entry's uuid and the transcript
    // row's uuid; the ledger row carries the words' digest (never their
    // content — the digest law) and the operator's attribution.
    const dispatch = await import('../../src/daemon/concourseDispatch.ts')
    const rows = Object.values(dispatch.readConcourseDispatches(daemonDir))
    const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const mine = rows.find(r => r.sessionId === sid && r.promptDigest === dispatch.promptDigestOf(WORDS))
    check('N4 the typed words rode the dispatch ledger to the session — the row keyed by the ONE identity (a bare uuid), carrying the words\' digest and the operator\'s attribution', mine !== undefined && UUID_SHAPE.test(mine.clientMessageId) && mine.by === 'operator' && (mine.state === 'working' || mine.state === 'settled' || mine.state === 'starting'), `row=${mine ? `${mine.clientMessageId} ${mine.state} by=${mine.by ?? ''}` : 'none'}; ids=${rows.map(r => `${r.clientMessageId}:${r.state}`).join(' ')}`)
    check("N4 the session's file gained the operator's row", await untilAsync(async () => logText().includes(WORDS), 20_000))
    // The file holds versioned records (the envelope carries the entry;
    // the uuid rides inside it), so the rows are read the way the focused
    // chat's connector reads them: through the transcript reader's chain
    // door, which hands back the conversation rows with the envelope
    // stripped — a hand-parsed line sees the envelope, never the row.
    const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
    const userRowUuids = async (): Promise<string[]> => {
      const chain = await reader.readTranscriptChainSince(log, null)
      return chain.rows.flatMap(r => (r.type === 'user' && typeof (r as { uuid?: unknown }).uuid === 'string' ? [(r as { uuid: string }).uuid] : []))
    }
    check("N4 …and that row wears the SAME identity: the transcript's user row uuid IS the ledger's clientMessageId", mine !== undefined && (await userRowUuids()).includes(mine.clientMessageId), `user uuids=${(await userRowUuids()).join(',')}`)
    check('N4 …and the session answered them', await untilAsync(async () => logText().includes('hi back — the words landed.'), 20_000))
    const echoed = hoppedFrames.filter(g => text(g).includes(WORDS))
    check('N4 the words painted in the focused chat (the echo, then the row)', echoed.length > 0, `frames: ${echoed.map(g => g.atMs).join(',') || 'none'}`)
    const said = (needle: string): number[] => grabs.filter(g => text(g).includes(needle)).map(g => g.atMs)
    for (const needle of ['did not commit', 'may be mid-turn', 'esc there', 'settling —', 'finishing this thought', 'your text is kept']) {
      check(`no frame says "${needle}"`, said(needle).length === 0, said(needle).join(','))
    }
    if (process.env.SWITCH_KEEP === '1') {
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs}`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, COLS - 2))
      }
      console.log(`[keep] arena home=${run.paths.home} cwd=${run.paths.cwd}`)
    }
  } finally {
    if (process.env.SWITCH_KEEP !== '1') run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon?.kill('SIGTERM')
  await api.close()
  if (process.env.SWITCH_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nprove-seat-needs-you (${COLS}x${ROWS}): ALL LAWS HOLD` : `\nprove-seat-needs-you (${COLS}x${ROWS}): ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

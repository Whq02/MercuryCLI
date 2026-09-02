#!/usr/bin/env bun
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
      `after:${N}:900:\t`,
      `after:${N}:1500:\r`,
      `after:${N}:2100:\r`,
      `after:${N}:5500:\r`,
      `after:${N}:12500:${WORDS}`,
      `after:${N}:13300:\r`,
    ],
    seconds: 30,
    cols: COLS,
    rows: ROWS,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify(askRule))
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const d = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'seat-needs-you',
        prompt: 'tidy the scratch folder',
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
    const hoppedFrames = grabs.filter(
      g =>
        !text(g).includes('SESSION CONCOURSE') &&
        (text(g).includes('tidy the scratch folder') ||
          text(g).includes('about to tidy up') ||
          text(g).includes('⇧← back') ||
          text(g).includes('Do you want to proceed?')),
    )
    const cardFrames = hoppedFrames.filter(
      g => text(g).includes('Bash command') && text(g).includes('Do you want to proceed?') && text(g).includes('rm -f'),
    )
    check(
      'N2 entering shows the FULL consent card — the tool, the command, the choices, the amend/explain keys',
      cardFrames.some(g => /1\. Yes/.test(text(g)) && /2\. No/.test(text(g)) && text(g).includes('tab amend')),
      `hopped frames: ${hoppedFrames.map(g => g.atMs).join(',') || 'none'}; with the card: ${cardFrames.map(g => g.atMs).join(',') || 'none'}`,
    )
    check(
      'N2 …and the card explains the ask as the boot session\'s card does (the rule Bash(rm:*) + the /permissions hint)',
      cardFrames.some(
        g =>
          /The rule Bash\(rm:\*\) requires confirmation for this command/.test(text(g)) &&
          text(g).includes('Permission rules can be changed in /permissions'),
      ),
    )
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
    const dispatch = await import('../../src/daemon/concourseDispatch.ts')
    const rows = Object.values(dispatch.readConcourseDispatches(daemonDir))
    const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const mine = rows.find(r => r.sessionId === sid && r.promptDigest === dispatch.promptDigestOf(WORDS))
    check('N4 the typed words rode the dispatch ledger to the session — the row keyed by the ONE identity (a bare uuid), carrying the words\' digest and the operator\'s attribution', mine !== undefined && UUID_SHAPE.test(mine.clientMessageId) && mine.by === 'operator' && (mine.state === 'working' || mine.state === 'settled' || mine.state === 'starting'), `row=${mine ? `${mine.clientMessageId} ${mine.state} by=${mine.by ?? ''}` : 'none'}; ids=${rows.map(r => `${r.clientMessageId}:${r.state}`).join(' ')}`)
    check("N4 the session's file gained the operator's row", await untilAsync(async () => logText().includes(WORDS), 20_000))
    const userRowUuids = (): string[] =>
      logText()
        .split('\n')
        .filter(l => l.trim() !== '')
        .flatMap(l => {
          try {
            const row = JSON.parse(l) as { type?: string; uuid?: string }
            return row.type === 'user' && typeof row.uuid === 'string' ? [row.uuid] : []
          } catch {
            return []
          }
        })
    check("N4 …and that row wears the SAME identity: the transcript's user row uuid IS the ledger's clientMessageId", mine !== undefined && userRowUuids().includes(mine.clientMessageId), `user uuids=${userRowUuids().join(',')}`)
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
  }
  daemon?.kill('SIGTERM')
  await api.close()
  if (process.env.SWITCH_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nprove-seat-needs-you (${COLS}x${ROWS}): ALL LAWS HOLD` : `\nprove-seat-needs-you (${COLS}x${ROWS}): ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

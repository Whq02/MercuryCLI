#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-mission-continue-live.ts — the verifier's refutation
//  repro, closed: mission continuity across the BOOT-FLAG resume paths,
//  driven end to end on the REAL binary (dist/mercury.mjs, real PTY,
//  scratch home, loopback fixture).
//
//  The finding (lane CP-B-V, finding 1): `mercury --continue` and
//  `mercury --resume <id>` boot through processResumedConversation, which
//  never re-armed the mission — and the continued process could answer a
//  different getSessionId() than the adopted transcript, so even the card
//  read missed. The fix routes BOTH boot paths through the shared
//  restoreMissionContinuity seam (sessionRestore.ts), reads the card under
//  the transcript's OWN id, arms under the live id, and migrates the card
//  ('continued' pointer) on an id split.
//
//    WORLD 1 (--continue):
//      A1 arm a mission on a fresh boot; the armed card lands on disk
//      B1 `--continue`: the debug log carries the re-arm line, exactly one
//         ARMED card remains store-wide (an id-split leaves the old card
//         'continued', never orphaned-armed), and /mission paints the
//         standing mission with the re-armed reason
//    WORLD 2 (--resume <id>): the same three legs on the explicit-id path
//    WORLD 3 (--continue transcript continuity, small-fix bundle item 1):
//      three REAL settled turns, then `--continue` paints the prior rows and
//      the first resumed request carries them on the wire (the metadata-only
//      getLogByIndex adoption resumed an EMPTY conversation).
//
//  Run: ~/.bun/bin/bun run scripts/journey/prove-mission-continue-live.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

const GOAL = 'the continuity gap is proven and receipted'

// ── one fixture server for both worlds (own process — sandbox law) ─────────
const SCRATCH = path.join(realpathSync(tmpdir()), `mercury-missioncont-${process.pid}`)
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
const fixture: ChildProcess = spawn(BUN, ['run', path.join(import.meta.dir, 'mission-fixture-server.ts')], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const reap = (): void => {
  try {
    fixture.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  if (failures === 0) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  } else {
    console.log(`[forensics] worlds kept: ${SCRATCH}`)
  }
}
process.on('exit', reap)

// ── world plumbing ─────────────────────────────────────────────────────────
interface World {
  home: string
  cwd: string
}
function makeWorld(name: string): World {
  const home = path.join(SCRATCH, name)
  const cwd = path.join(home, 'repo')
  mkdirSync(cwd, { recursive: true })
  const probeKey = 'sk-ant-missioncont-probe'
  writeFileSync(
    path.join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [probeKey.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({}))
  writeFileSync(path.join(cwd, 'README.md'), '# mission continuity fixture\n')
  return { home, cwd }
}

function worldEnv(world: World, baseOverride?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEBUG: '1',
    MERCURY_CONFIG_DIR: world.home,
    ANTHROPIC_API_KEY: 'sk-ant-missioncont-probe',
    ANTHROPIC_BASE_URL: baseOverride ?? base,
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(world.home, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(world.home, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(world.home, 'teams'),
    MERCURY_TABULA_DIR: path.join(world.home, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: path.join(world.home, 'proof-home'),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_MODEL
  return env
}

function drive(
  world: World,
  name: string,
  argvTail: string[],
  sends: unknown[],
  readyText: string[],
  total: number,
  opts?: { base?: string; rows?: number },
): string {
  const out = path.join(world.home, `grid-${name}.json`)
  const cfg = {
    argv: ['node', DIST, ...argvTail],
    cwd: world.cwd,
    sends,
    readyText,
    readySettleTicks: 4,
    total,
    cols: 110,
    rows: opts?.rows ?? 34,
    out,
  }
  const cfgPath = path.join(world.home, `cfg-${name}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(150_000),
    cwd: world.cwd,
    env: worldEnv(world, opts?.base),
  })
  if (!existsSync(out)) {
    check(`${name}: capture produced a grid`, false, `vshot: ${String(res.stderr).slice(0, 300)}`)
    return ''
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  return payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}

// ── card + debug forensics ─────────────────────────────────────────────────
interface CardOnDisk {
  file: string
  sessionId: string
  goal: string
  state: string
  nextStep: string | null
}
function readCards(world: World): CardOnDisk[] {
  const out: CardOnDisk[] = []
  const projects = path.join(world.home, 'projects')
  if (!existsSync(projects)) return out
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name)
      if (name.isDirectory()) walk(full)
      else if (dir.endsWith('/missions') && name.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as CardOnDisk & { schema: number }
          out.push({ file: name.name, sessionId: parsed.sessionId, goal: parsed.goal, state: parsed.state, nextStep: parsed.nextStep })
        } catch {
          /* corrupt card = absent */
        }
      }
    }
  }
  walk(projects)
  return out
}

function debugText(world: World): string {
  const dir = path.join(world.home, 'debug')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .map(name => {
      try {
        return readFileSync(path.join(dir, name), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

console.log('============================================================')
console.log(' mission continuity LIVE — the boot-flag resume paths')
console.log('============================================================')

const ARM_SENDS = [
  // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
  { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { atTick: 90, minTick: 20, awaitText: '? for shortcuts', data: `/mission ${GOAL}\r` },
]

function stageA(world: World, label: string): { armedSessionId: string | null } {
  section(`${label} — stage A: arm on a fresh boot; the armed card lands`)
  const grid = drive(world, 'arm', [], ARM_SENDS, ['Mission set'], 140)
  check('the arm confirmation painted', grid.includes('Mission set'), grid.slice(-400))
  const cards = readCards(world)
  const armed = cards.filter(c => c.state === 'armed')
  check('exactly one ARMED card on disk', armed.length === 1, JSON.stringify(cards))
  check('the card carries the goal verbatim', armed[0]?.goal === GOAL, armed[0]?.goal)
  const debug = debugText(world)
  check('the debug log records the install', debug.includes('[mission] installed standing mission'), 'no install line')
  return { armedSessionId: armed[0]?.sessionId ?? null }
}

function stageB(world: World, label: string, argvTail: string[]): void {
  section(`${label} — stage B: ${argvTail.join(' ')} re-arms and reports`)
  const before = debugText(world)
  const grid = drive(
    world,
    `resume-${argvTail[0]!.replace(/^--/, '')}`,
    argvTail,
    [
      // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 110, minTick: 24, awaitText: '? for shortcuts', data: '/mission\r' }],
    ['Standing mission'],
    240,
  )
  const after = debugText(world)
  // Presence-diff, not offset-diff: the resumed boot writes its OWN debug
  // file and readdir order interleaves them, so byte offsets misalign.
  check(
    'the debug log records the RE-ARM',
    !before.includes('[mission] re-armed from card') && after.includes('[mission] re-armed from card'),
    after.slice(-300) || '(no debug lines)',
  )
  check('/mission paints the standing mission', grid.includes('Standing mission'), grid.slice(-600))
  check('the panel carries the goal', grid.includes(GOAL))
  check('the panel names the resume re-arm', grid.includes('re-armed on resume'), grid.slice(-600))
  const cards = readCards(world)
  const armed = cards.filter(c => c.state === 'armed')
  check('exactly one ARMED card store-wide after the resume', armed.length === 1, JSON.stringify(cards))
  check('the armed card still carries the goal', armed[0]?.goal === GOAL)
  const split = cards.filter(c => c.state === 'continued')
  check(
    'an id-split leaves the old card `continued` (never orphaned-armed); same-id leaves no residue',
    split.every(c => (c.nextStep ?? '').includes('continued in session')),
    JSON.stringify(split),
  )
}

// WORLD 1: --continue
{
  const world = makeWorld('world-continue')
  const { armedSessionId } = stageA(world, 'WORLD 1')
  check('stage A yielded a session id', armedSessionId !== null)
  stageB(world, 'WORLD 1', ['--continue'])
}

// WORLD 2: --resume <id>
{
  const world = makeWorld('world-resume')
  const { armedSessionId } = stageA(world, 'WORLD 2')
  if (armedSessionId === null) {
    check('WORLD 2 stage A yielded a session id', false)
  } else {
    stageB(world, 'WORLD 2', ['--resume', armedSessionId])
  }
}

// WORLD 3: --continue TRANSCRIPT continuity (small-fix bundle item 1).
// The metadata-only listing (getLogByIndex → enrichLog fills labels, never
// messages) fed processResumedConversation an EMPTY conversation: no prior
// rows painted, and the first resumed request carried none of them. Three
// REAL settled turns land on disk against a fast fixture instance, then
// `--continue` must paint them AND send them on the very next request.
{
  const world = makeWorld('world-transcript')
  const capture = path.join(world.home, 'wire-capture.jsonl')
  const fast: ChildProcess = spawn(
    BUN,
    ['run', path.join(import.meta.dir, 'mission-fixture-server.ts'), capture],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MISSION_FIXTURE_REPLY_DELAY_MS: '300' },
    },
  )
  const fastPort = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error('fast fixture never printed PORT')), 15_000)
    let buffer = ''
    fast.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const m = /PORT (\d+)/.exec(buffer)
      if (m) {
        clearTimeout(killer)
        resolve(Number(m[1]))
      }
    })
    fast.on('exit', code => reject(new Error(`fast fixture exited early (${code})`)))
  }).catch(err => {
    console.log(`FAIL ${String(err)}`)
    process.exit(1)
  })
  const fastBase = `http://127.0.0.1:${fastPort}`
  try {
    section('WORLD 3 — stage A: three real turns settle and land on disk')
    const TURNS = [
      'continuity turn one alpha-goose',
      'continuity turn two beta-heron',
      'continuity turn three gamma-ibis',
    ]
    const gridA = drive(
      world,
      'turns',
      [],
      [
        // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 90, minTick: 20, awaitText: '? for shortcuts', data: `${TURNS[0]}\r` },
        { atTick: 180, minTick: 30, awaitText: 'reply to [[continuity turn one', data: `${TURNS[1]}\r` },
        { atTick: 270, minTick: 40, awaitText: 'reply to [[continuity turn two', data: `${TURNS[2]}\r` },
        { atTick: 360, minTick: 50, awaitText: 'reply to [[continuity turn three', data: '/exit\r' },
      ],
      [],
      420,
      { base: fastBase, rows: 44 },
    )
    check(
      'three turns settled (the third reply painted)',
      gridA.includes('reply to [[continuity turn three'),
      gridA.slice(-400),
    )

    section('WORLD 3 — stage B: --continue restores the rows and the wire carries them')
    // Send 4 GATES on the restored turn-1 row; on a regressed build the
    // await degrades to the atTick deadline, the prompt still goes, and the
    // row/wire checks below fail loudly instead of hanging the capture.
    const gridB = drive(
      world,
      'continue-transcript',
      ['--continue'],
      [
        {
          atTick: 200,
          minTick: 24,
          awaitText: 'alpha-goose',
          data: 'continuity turn four delta-crane\r',
        },
      ],
      ['reply to [[continuity turn four'],
      340,
      { base: fastBase, rows: 44 },
    )
    for (const [i, t] of TURNS.entries()) {
      check(`prior row ${i + 1} painted after --continue`, gridB.includes(t), gridB.slice(-600))
    }
    check(
      'a prior assistant reply painted after --continue',
      gridB.includes('reply to [[continuity turn one'),
      gridB.slice(-600),
    )
    check(
      'the resumed turn answered (turn-4 reply painted)',
      gridB.includes('reply to [[continuity turn four'),
      gridB.slice(-400),
    )
    let wireRows: Array<{ path: string; body: unknown }> = []
    try {
      wireRows = readFileSync(capture, 'utf8')
        .trim()
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l) as { path: string; body: unknown })
        .filter(r => r.path.endsWith('/v1/messages'))
    } catch {
      /* absent capture fails the checks below with an empty set */
    }
    // The resumed request is the one CARRYING the new prompt (side calls and
    // ordering stay out of the adjudication).
    const resumedBodies = wireRows
      .map(r => JSON.stringify(r.body ?? null))
      .filter(s => s.includes('continuity turn four delta-crane'))
    check('the resumed request reached the wire', resumedBodies.length > 0, `${wireRows.length} /v1/messages rows`)
    const first = resumedBodies[0] ?? ''
    check(
      'the FIRST RESUMED request carries all three prior turns',
      TURNS.every(t => first.includes(t)),
      first.slice(0, 400),
    )
    check(
      '…and a prior assistant reply',
      first.includes('standing reply to [[continuity turn one'),
      first.slice(0, 400),
    )
  } finally {
    try {
      fast.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ MISSION CONTINUITY LIVE — both boot-flag paths re-arm' : `❌ ${failures} MISSION-CONTINUITY-LIVE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

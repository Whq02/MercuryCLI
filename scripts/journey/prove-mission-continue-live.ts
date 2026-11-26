#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const { reapDaemonFoldersSync } = createRequire(import.meta.url)('../lib/proofScratch.cjs') as {
  reapDaemonFoldersSync: (folders: string[], graceMs?: number) => void
}

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
const check = (label: string, ok: boolean, detail = '', fixHint = ''): void => {
  if (!ok) failures++
  const failText = [detail, fixHint].filter(Boolean).join(' — ')
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && failText ? ` — ${failText}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

const GOAL = 'the continuity gap is proven and receipted'

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
  }
  try {
    reapDaemonFoldersSync([SCRATCH])
  } catch {
  }
  if (failures === 0) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
    }
  } else {
    console.log(`[forensics] worlds kept: ${SCRATCH}`)
  }
}
process.on('exit', reap)

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
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_HEALTH_STATE_DIR: path.join(world.home, 'health-state'),
    MERCURY_DAEMON_DIR: path.join(world.home, 'daemon'),
    MERCURY_HOME: path.join(world.home, 'proof-home'),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.MERCURY_MODEL
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
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
  const grid = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
  for (const m of payload.marks ?? []) {
    writeFileSync(path.join(world.home, `mark-${name}-${m.label}.txt`), m.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n'))
  }
  if (readyText.length > 0 && !readyText.some(t => grid.includes(t))) {
    console.log(`  [vshot ${name}] ${String(res.stderr ?? '').trim().replace(/\s+/g, ' ').slice(-700)}`)
  }
  return grid
}

function markText(world: World, name: string, label: string): string {
  try {
    return readFileSync(path.join(world.home, `mark-${name}-${label}.txt`), 'utf8')
  } catch {
    return ''
  }
}

interface CardOnDisk {
  file: string
  sessionId: string
  goal: string
  state: string
  nextStep: string | null
  iterations: number
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
          out.push({ file: name.name, sessionId: parsed.sessionId, goal: parsed.goal, state: parsed.state, nextStep: parsed.nextStep, iterations: typeof parsed.iterations === 'number' ? parsed.iterations : 0 })
        } catch {
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

const ARM_TURN = 'mission arm turn one'
const ARM_SENDS = [
  { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { atTick: 90, minTick: 20, awaitText: '? for shortcuts', data: `${ARM_TURN}\r` },
  { atTick: 150, minTick: 30, awaitText: 'esc interrupts', awaitSettleTicks: 2, data: `/goal ${GOAL}\r` },
]

function stageA(world: World, label: string): { armedSessionId: string | null } {
  section(`${label} — stage A: arm on a fresh boot; the armed card lands`)
  const grid = drive(world, 'arm', [], ARM_SENDS, ['Goal set'], 200)
  check('the arm confirmation painted', grid.includes('Goal set'), grid.slice(-400), 'the /goal command (src/commands/mission/mission-jsx.tsx) must finish with Goal set: <goal>; if the grid never left the boot face, read the [vshot arm] line above')
  const cards = readCards(world)
  const armed = cards.filter(c => c.state === 'armed')
  check('exactly one ARMED card on disk', armed.length === 1, JSON.stringify(cards), 'setActiveMission in src/permissions/guards/mission.ts must write one card with state armed under projects/<cwd>/missions in the config home')
  check('the card carries the goal verbatim', armed[0]?.goal === GOAL, armed[0]?.goal, 'the card setActiveMission writes (src/permissions/guards/mission.ts) must keep the goal text unchanged')
  const debug = debugText(world)
  check('the debug log records the install', debug.includes('[mission] installed standing mission'), 'no install line', 'setActiveMission in src/permissions/guards/mission.ts logs this line through logForDebugging; the drive runs with DEBUG=1 and reads the config home debug folder')
  reapDaemonFoldersSync([path.join(world.home, 'daemon')])
  return { armedSessionId: armed[0]?.sessionId ?? null }
}

const STAGE_B_READY = 'ready ·'
check(
  'stage B waits on the runner-settled status word rather than ⇧← back, which paints while the runner is still starting',
  !'Opus 5.5 · high · the runner is starting · 5s  repo  ⇧← back'.includes(STAGE_B_READY) &&
    'ready · Opus 5.5 · high  repo  ⇧← back'.includes(STAGE_B_READY),
)

function stageB(world: World, label: string, argvTail: string[]): void {
  section(`${label} — stage B: ${argvTail.join(' ')} re-arms and reports`)
  const before = debugText(world)
  const grid = drive(
    world,
    `resume-${argvTail[0]!.replace(/^--/, '')}`,
    argvTail,
    [
      { requireAwait: true, minTick: 15, awaitText: STAGE_B_READY, awaitSettleTicks: 3, data: '/goal\r' },
      { data: '', afterPrevTicks: 15, mark: 'after-mission' }],
    ['Standing goal'],
    240,
  )
  const asked = markText(world, `resume-${argvTail[0]!.replace(/^--/, '')}`, 'after-mission')
  const shown = `${grid}\n${asked}`
  const after = debugText(world)
  check(
    'the debug log records the RE-ARM',
    !before.includes('[mission] re-armed from card') && after.includes('[mission] re-armed from card'),
    after.slice(-300) || '(no debug lines)',
    'rearmMissionFromCard in src/permissions/guards/mission.ts must log [mission] re-armed from card when --continue or --resume boots into the session',
  )
  check('/goal paints the standing goal', shown.includes('Standing goal'), asked.split('\n').filter(l => l.trim()).slice(-12).join('\n'), 'the /goal panel in src/commands/mission/mission-jsx.tsx must print the Standing goal title when a goal is armed; the stage B drive sends /goal once the status line reads ready')
  const panelRows = asked.split('\n')
  const titleRow = panelRows.findIndex(l => l.includes('Standing goal'))
  const stateRow = panelRows.findIndex((l, i) => i > titleRow && l.includes('re-armed on resume'))
  const goalRow = panelRows.findIndex((l, i) => i > stateRow && l.includes(GOAL))
  check('the panel paints as rows: the title, then the state with the re-arm reason, then the goal whole', titleRow >= 0 && stateRow > titleRow && goalRow > stateRow, `title@${titleRow} state@${stateRow} goal@${goalRow} · ${panelRows.filter(l => /Standing goal|re-armed|clear" to drop/.test(l) || l.includes(GOAL)).map(l => l.trim()).join(' | ').slice(0, 300)}`, 'the panel in src/commands/mission/mission-jsx.tsx must print the title row, then the state row with the reason, then the whole goal, each on its own row')
  check('the panel names the resume re-arm', shown.includes('re-armed on resume'), asked.split('\n').filter(l => /goal|Goal/.test(l)).join(' | ').slice(0, 400), 'rearmMissionFromCard in src/permissions/guards/mission.ts sets lastReason to re-armed on resume; the panel in src/commands/mission/mission-jsx.tsx must show it')
  const cards = readCards(world)
  const armed = cards.filter(c => c.state === 'armed')
  check('exactly one ARMED card store-wide after the resume', armed.length === 1, JSON.stringify(cards), 'rearmMissionFromCard in src/permissions/guards/mission.ts must leave one armed card: reuse the card when the session id is the same, and mark the old one continued when the id splits')
  check('the armed card still carries the goal', armed[0]?.goal === GOAL, '', 'the card rewritten by rearmMissionFromCard in src/permissions/guards/mission.ts must keep the goal')
  const split = cards.filter(c => c.state === 'continued')
  check(
    'an id-split leaves the old card `continued` (never orphaned-armed); same-id leaves no residue',
    split.every(c => (c.nextStep ?? '').includes('continued in session')),
    JSON.stringify(split),
    'rearmMissionFromCard in src/permissions/guards/mission.ts must set nextStep to continued in session <id> on the old card when it hands the mission to a new session id',
  )
}

{
  const world = makeWorld('world-continue')
  const { armedSessionId } = stageA(world, 'WORLD 1')
  check('stage A yielded a session id', armedSessionId !== null, '', 'stage A found no armed card on disk; read the failed stage A checks above, since setActiveMission in src/permissions/guards/mission.ts writes the card')
  stageB(world, 'WORLD 1', ['--continue'])
}

{
  const world = makeWorld('world-resume')
  const { armedSessionId } = stageA(world, 'WORLD 2')
  if (armedSessionId === null) {
    check('WORLD 2 stage A yielded a session id', false, '', 'stage A found no armed card on disk; read the failed stage A checks above, since setActiveMission in src/permissions/guards/mission.ts writes the card')
  } else {
    stageB(world, 'WORLD 2', ['--resume', armedSessionId])
  }
}

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
        { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
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
      'the three typed turns must each get the fixture server reply (scripts/journey/mission-fixture-server.ts) before /exit; read the grid tail to see which turn stalled',
    )
    reapDaemonFoldersSync([path.join(world.home, 'daemon')])

    section('WORLD 3 — stage B: --continue restores the rows and the wire carries them')
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
      check(`prior row ${i + 1} painted after --continue`, gridB.includes(t), gridB.slice(-600), 'booting with --continue must restore the stored transcript rows of the last session into the screen')
    }
    check(
      'a prior assistant reply painted after --continue',
      gridB.includes('reply to [[continuity turn one'),
      gridB.slice(-600),
      'booting with --continue must restore assistant replies as well as the typed rows',
    )
    check(
      'the resumed turn answered (turn-4 reply painted)',
      gridB.includes('reply to [[continuity turn four'),
      gridB.slice(-400),
      'after --continue a new typed turn must reach the fixture server and be answered; the drive types it once the first prior row is on screen',
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
    }
    const resumedBodies = wireRows
      .map(r => JSON.stringify(r.body ?? null))
      .filter(s => s.includes('continuity turn four delta-crane'))
    check('the resumed request reached the wire', resumedBodies.length > 0, `${wireRows.length} /v1/messages rows`, 'the turn typed after --continue must send a /v1/messages request that the fixture server records in wire-capture.jsonl')
    const first = resumedBodies[0] ?? ''
    check(
      'the FIRST RESUMED request carries all three prior turns',
      TURNS.every(t => first.includes(t)),
      first.slice(0, 400),
      'the first request after --continue must include the restored prior turns in its messages, not only the new prompt',
    )
    check(
      '…and a prior assistant reply',
      first.includes('standing reply to [[continuity turn one'),
      first.slice(0, 400),
      'the first request after --continue must include the restored assistant reply as an assistant message',
    )

    section('WORLD 4 — a mission armed on a hosted chat fires its Stop hook in the seat')
    const world4 = makeWorld('world-seat-hook')
    const ARM4 = 'seat hook turn one'
    const AFTER4 = 'seat hook turn two'
    const grid4 = drive(
      world4,
      'seat-hook',
      [],
      [
        { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 90, minTick: 20, awaitText: '? for shortcuts', data: `${ARM4}\r` },
        { atTick: 180, minTick: 30, awaitText: `reply to [[${ARM4}`, data: `/goal ${GOAL}\r` },
        { atTick: 240, minTick: 40, awaitText: 'Goal set', data: `${AFTER4}\r` },
      ],
      [`reply to [[${AFTER4}`],
      360,
      { base: fastBase, rows: 44 },
    )
    const transcript4 = (() => {
      const dir = path.join(world4.home, 'projects')
      const found: string[] = []
      const walk = (d: string): void => {
        if (!existsSync(d)) return
        for (const name of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, name.name)
          if (name.isDirectory()) walk(full)
          else if (name.name.endsWith('.jsonl')) found.push(readFileSync(full, 'utf8'))
        }
      }
      walk(dir)
      return found.join('\n')
    })()
    check('WORLD 4 the turn after the arm settled (the transcript carries the prompt and its reply)', transcript4.includes(AFTER4) && transcript4.includes(`reply to [[${AFTER4}`), grid4.slice(-400), 'the turn typed after /mission must be answered and saved to the session transcript under projects in the config home')
    const cards4 = readCards(world4)
    const card4 = cards4.find(c => c.iterations >= 1) ?? cards4.find(c => c.state === 'armed') ?? cards4[0]
    const transcripts4: string[] = []
    const walk4 = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name)
        if (name.isDirectory()) walk4(full)
        else if (name.name.endsWith('.jsonl') && !name.name.endsWith('.receipts.jsonl')) transcripts4.push(name.name.slice(0, -'.jsonl'.length))
      }
    }
    walk4(path.join(world4.home, 'projects'))
    check('WORLD 4 the card is keyed by the CONVERSATION (a transcript on disk carries the same id)', card4 !== undefined && transcripts4.includes(card4.sessionId), `card ${card4?.sessionId ?? '(none)'} · transcripts ${transcripts4.join(',')}`, 'setActiveMission in src/permissions/guards/mission.ts must key the card by conversationIdHere, the id of the transcript file, not by the hosting runner id')
    check("WORLD 4 the mission's Stop hook fired in the seat (the card counts a check)", (card4?.iterations ?? 0) >= 1, JSON.stringify(cards4), 'the mission Stop hook in src/permissions/guards/mission.ts must run inside the hosting seat process after the turn that follows /mission, and count the check on the card')
    const debugDir4 = path.join(world4.home, 'debug')
    const seatLog = (existsSync(debugDir4) ? readdirSync(debugDir4) : [])
      .map(name => {
        try {
          return readFileSync(path.join(debugDir4, name), 'utf8')
        } catch {
          return ''
        }
      })
      .find(text => text.includes(`[session-runner] claimed: session ${card4?.sessionId ?? '(no card)'}`)) ?? ''
    const seatLines = seatLog.split('\n').filter(l => l.includes('[mission]'))
    check('WORLD 4 the seat armed the mission in its own process and logged its checks', seatLines.some(l => /installed standing mission|re-armed from card/.test(l)) && seatLines.some(l => /Mission not yet met|pauses: \d+ turns without a tool call/.test(l)), seatLines.map(l => l.slice(-110)).join(' | ').slice(-400) || 'no [mission] line in the runner\'s own debug file', 'the seat process must arm the mission itself (setActiveMission or rearmMissionFromCard in src/permissions/guards/mission.ts) and log its Mission not yet met or pause line to its own debug file')
  } finally {
    try {
      fast.kill('SIGTERM')
    } catch {
    }
  }
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ MISSION CONTINUITY LIVE — both boot-flag paths re-arm' : `❌ ${failures} MISSION-CONTINUITY-LIVE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

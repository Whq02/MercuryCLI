#!/usr/bin/env bun
// gate-class: heavy
// ============================================================================
//  scripts/notifications/prove-session-identity.ts —
//  R4 (IDENTITY-ATOMIC): board selection, Peek and the full-session
//  route name the SAME stable session; the §5.8 effective-settings capture
//  is immutable per session while Boot edits reach only FUTURE sessions —
//  and the Peek distinguishes both sides of that line.
//
//  §1  ATOMIC IDENTITY — one live worker: the snapshot's peek names the
//      selected sessionId, the board row carries the same id + title, and
//      the route owner enters a 'session' route with the identical id.
//  §2  REVISION JOURNEY — the admitted record captured profile r_before;
//      a REAL Boot edit (saveBootDefaultsProfile through the startup-menu
//      owner, a declared row + declared choice) bumps the profile; the
//      EXISTING record's capture is UNCHANGED, the peek now says the
//      profile moved on (current:false), and the NEXT resolve captures the
//      new revision.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'session-identity-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const ws = join(SCRATCH, 'ws-id')
const crewDir = join(SCRATCH, 'crew')
const draftDir = join(SCRATCH, 'draft')
for (const d of [home, daemonDir, work, ws, crewDir, draftDir]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
seedFirstRun(home, [work, ws])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { enableConfigs: __enableConfigs } = await import('../../src/utils/config.ts')
__enableConfigs()
const __wm = await import('../../src/services/concourse/workerModels.ts')
const RIG_MODEL = __wm.defaultWorkerModelId(await __wm.composeWorkerModelRegistry(), 'session')
const api = await startFixtureApi([{ kind: 'text', text: 'pong — the identity worker turn' }])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — identity journey exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(250)
  }
}

console.log('session identity — atomic board/peek/route naming + the §5.8 revision line')

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const env = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  ANTHROPIC_API_KEY: 'fixture-key',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CACHE_CLOCK: '0',
}
const daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
  cwd: work,
  env,
  stdio: ['ignore', logFd, logFd],
})

try {
  const up = await untilAsync(async () => {
    try {
      return ((await daemonControlRpc({ op: 'concourseList' } as never, { timeoutMs: 2000 })) as { ok?: boolean }).ok === true
    } catch {
      return false
    }
  }, 60_000)
  check('the daemon is up', up)

  const dispatch = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'id-1',
      prompt: 'say pong',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      title: 'Identity worker',
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; sessionId?: string; error?: string }
  check('dispatch admits + delivers', dispatch.ok === true, dispatch.error ?? '')
  const sessionId = String(dispatch.sessionId ?? '')

  // ── §1 atomic identity: board row ↔ peek ↔ route, one id ─────────────────
  const { buildConcourseSnapshot } = await import('../../src/services/concourse/concourseSnapshot.ts')
  // The board is project-scoped: the builder is handed the dispatched
  // workspace's identity (the process cwd is the repo, not ws).
  const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
  const snapOpts = { recordsDir: daemonDir, crewDir, draftDir, peekSessionId: sessionId, project: projectIdentity(ws) }
  const snapA = await buildConcourseSnapshot(snapOpts)
  const boardRow = snapA.groups.flatMap(g => g.rows).find(r => r.sessionId === sessionId)
  check('the board carries the session row', boardRow !== undefined)
  check('board row and peek name the SAME session', snapA.peek?.sessionId === sessionId, String(snapA.peek?.sessionId))
  check('board row and peek carry the SAME title', boardRow?.title === 'Identity worker' && snapA.peek?.title === 'Identity worker', `${boardRow?.title} / ${snapA.peek?.title}`)
  const route = await import('../../src/context/surfaceRoute.ts')
  // The 'session' surface registers as a MODULE SIDE EFFECT of the concourse
  // route (the same registration the product performs at boot via
  // SurfaceRouter's import) — without it enter() refuses 'surface-unregistered'.
  await import('../../src/components/concourse/ConcourseRoute.tsx')
  const entered = route.enterSessionRepl(sessionId)
  const now = route.currentSurfaceRoute() as { kind: string; sessionId?: string }
  // Re-pinned (the one-terminal full swap): entering a session
  // is the ROOT-REPL swap now — the 'session:<id>' route survives as a
  // typed target with NO registered surface, and the transition API must
  // refuse it HONESTLY (capability-optimism class) instead of landing a
  // lookalike screen. The id-identity law lives at the swap's chokepoint
  // (drainSwap's getSessionId() === swap.sessionId — prove-w0-laws).
  check(
    "the retired 'session:<id>' route refuses honestly (surface-unregistered) — the swap is the enter path",
    entered.ok === false && (entered as { code?: string }).code === 'surface-unregistered' && now.kind === 'repl',
    JSON.stringify({ entered, now }),
  )

  // ── §2 the §5.8 revision line ─────────────────────────────────────────────
  const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
  const recBefore = Object.values(supervisor.readSessionWorkers(daemonDir)).find(r => r.sessionId === sessionId)
  const capBefore = recBefore?.settingsSnapshot?.profileRevision
  check('the admitted record carries the §5.8 capture', typeof capBefore === 'number', JSON.stringify(recBefore?.settingsSnapshot ?? null))
  check('the peek says the capture is CURRENT before any Boot edit', snapA.peek?.settings?.current === true && snapA.peek?.settings?.revisionLabel === `r${capBefore}`, JSON.stringify(snapA.peek?.settings ?? null))

  // A REAL Boot edit through the startup-menu owner: the first declared row,
  // its first declared choice — the same validated write the Boot surface
  // makes (never a hand-rolled profile file).
  const menu = await import('../../src/substrate/startupMenu.ts')
  const row0 = menu.STARTUP_MENU[0]!
  const choice0 = menu.menuRowChoices(row0)[0]!
  const saved = menu.saveBootDefaultsProfile({ [row0.env]: choice0.value }, undefined, { existingSessionsUnchanged: 1 })
  check('saveBootDefaultsProfile applies (a declared row + declared choice)', saved.ok === true, saved.ok ? '' : saved.reason)
  const newRev = saved.ok ? saved.revision : -1
  check('the profile revision advanced', saved.ok && newRev === (capBefore ?? 0) + 1, `r${capBefore} → r${newRev}`)

  const recAfter = Object.values(supervisor.readSessionWorkers(daemonDir)).find(r => r.sessionId === sessionId)
  check(
    'the EXISTING record’s capture is byte-unchanged after the Boot edit',
    JSON.stringify(recAfter?.settingsSnapshot) === JSON.stringify(recBefore?.settingsSnapshot),
    `before r${capBefore} after r${recAfter?.settingsSnapshot?.profileRevision}`,
  )
  const snapB = await buildConcourseSnapshot(snapOpts)
  check(
    'the peek DISTINGUISHES: the session keeps its capture while the profile moved on',
    snapB.peek?.settings?.current === false && snapB.peek?.settings?.revisionLabel === `r${capBefore}`,
    JSON.stringify(snapB.peek?.settings ?? null),
  )
  const probe = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'probe-next' })
  check('the NEXT session’s resolve captures the NEW revision', probe.profileRevision === newRev, `r${probe.profileRevision}`)
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 8000 })
  } catch {
    /* the spawn-kill below is the backstop */
  }
  daemon.kill('SIGTERM')
  await wait(500)
  try {
    daemon.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await api.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`  [evidence] scratch kept: ${SCRATCH}`)
}

if (failures > 0) {
  console.log(`\n❌ prove-session-identity — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ prove-session-identity — all checks pass')

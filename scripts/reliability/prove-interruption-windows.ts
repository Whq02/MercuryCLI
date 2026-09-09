import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { defineStore } from '../../src/substrate/fileStore.ts'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const BUN = process.execPath
const HELPERS = join(import.meta.dir, 'helpers')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const tmp = mkdtempSync(join(tmpdir(), 'mercury-relia-'))
const home = join(tmp, 'home')
const teams = join(tmp, 'teams')
const daemon = join(tmp, 'daemon')
mkdirSync(home, { recursive: true })
mkdirSync(teams, { recursive: true })
mkdirSync(daemon, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TEAMS_DIR = teams
process.env.MERCURY_DAEMON_DIR = daemon

const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_TEAMS_DIR: teams,
  MERCURY_DAEMON_DIR: daemon,
  MERCURY_SESSION_ROOM: '',
  MERCURY_ROOM_TOKEN: '',
  ...extra,
})

const runChild = (
  file: string,
  env: Record<string, string> = {},
): { status: number | null; signal: string | null; stdout: string; stderr: string } => {
  const res = spawnSync(BUN, ['run', join(HELPERS, file)], {
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

{
  const teamName = 'relia-fc1'
  const res = runChild('teamCreateJournalKillChild.ts', {
    RELIA_TEAM: teamName,
    MERCURY_FAULT_INJECT: 'journal-before-step@#task-epoch:kill',
  })
  const teamFilePath = join(teams, teamName, 'config.json')
  const teamVisibleBeforeRecovery = existsSync(teamFilePath)
  const journalHasIncomplete = existsSync(join(teams, '.journal'))
  const rec = runChild('teamRecoverChild.ts', {})
  const teamVisibleAfterRecovery = existsSync(teamFilePath)
  const tasksDirExists = existsSync(join(home, 'tasks', teamName))
  ok(res.signal === 'SIGKILL', 'FC1 child died abruptly at the team-file/task-epoch boundary')
  ok(
    teamVisibleBeforeRecovery && journalHasIncomplete,
    'FC1 FIXED (1/2): the interruption is RECORDED — the partial team is journal-tracked, not silently real',
  )
  ok(
    rec.status === 0 && !teamVisibleAfterRecovery && !tasksDirExists,
    'FC1 FIXED (2/2): recovery compensates the partial create — no team file, no task list survives',
  )
}

{
  const res = runChild('sidecarCollideChild.ts')
  let parsed: { rounds?: number; anomalies?: number; orphanTmps?: number } = {}
  try {
    parsed = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
  }
  ok(res.status === 0, `FC2 collide child ran (${res.status}${res.stderr ? ` — ${res.stderr.slice(0, 120)}` : ''})`)
  ok(
    (parsed.anomalies ?? -1) === 0 && (parsed.orphanTmps ?? -1) === 0,
    `FC2 FIXED: collision-free temps under overlap (${parsed.anomalies}/${parsed.rounds} anomalies, ${parsed.orphanTmps} orphan tmp(s))`,
  )
}


{
  const teamName = 'relia-fc4'
  const actLog = join(tmp, 'fc4-acts.log')
  writeFileSync(actLog, '')
  const reqA = 'relia-req-fc4-a'
  const sentA = runChild('mailboxSendChild.ts', { RELIA_TEAMNAME: teamName, RELIA_REQ: reqA })
  const lifeA1 = runChild('mailboxDrainChild.ts', {
    RELIA_TEAMNAME: teamName,
    RELIA_ACT_LOG: actLog,
    MERCURY_FAULT_INJECT: `bridge-after-complete@${reqA}:kill`,
  })
  const lifeA2 = runChild('mailboxDrainChild.ts', {
    RELIA_TEAMNAME: teamName,
    RELIA_ACT_LOG: actLog,
  })
  const actsA = readFileSync(actLog, 'utf8').split('\n').filter(l => l.startsWith(reqA))
  ok(
    sentA.status === 0 && lifeA1.signal === 'SIGKILL' && lifeA2.status === 0,
    'FC4-A lifecycle ran (send · act+complete+die-before-ack · restart)',
  )
  ok(
    actsA.length === 1,
    `FC4-A FIXED: acted-on dispatch executed EXACTLY once across the restart (${actsA.length}×) — the durable 'delivered' record consumed the redelivery`,
  )
  writeFileSync(actLog, '')
  const reqB = 'relia-req-fc4-b'
  const sentB = runChild('mailboxSendChild.ts', { RELIA_TEAMNAME: teamName, RELIA_REQ: reqB })
  const lifeB1 = runChild('mailboxDrainChild.ts', {
    RELIA_TEAMNAME: teamName,
    RELIA_ACT_LOG: actLog,
    RELIA_DIE_AFTER_ACT: '1',
  })
  const lifeB2 = runChild('mailboxDrainChild.ts', {
    RELIA_TEAMNAME: teamName,
    RELIA_ACT_LOG: actLog,
  })
  const actsB = readFileSync(actLog, 'utf8').split('\n').filter(l => l.startsWith(reqB))
  ok(
    sentB.status === 0 && lifeB1.signal === 'SIGKILL' && lifeB2.status === 0,
    'FC4-B lifecycle ran (send · die-mid-act · restart)',
  )
  ok(
    actsB.length === 2 && !actsB[0]!.includes('REPLAY') && actsB[1]!.includes('REPLAY'),
    `FC4-B FIXED: a mid-act death redelivers WITH the honest replay marker (${JSON.stringify(actsB)})`,
  )
}

{
  const storePath = join(tmp, 'fc5-inbox.json')
  const DAMAGED = '{"this is": the only damaged copy — NOT JSON'
  writeFileSync(storePath, DAMAGED)
  type Msg = { from: string; text: string; timestamp: string; read: boolean }
  const store = defineStore<Msg[], []>({
    name: 'relia-fc5-inbox',
    path: () => storePath,
    schemaVersion: 1,
    decode: raw =>
      Array.isArray(raw)
        ? raw.filter(
            (m): m is Msg =>
              !!m && typeof m === 'object' && typeof (m as Msg).from === 'string',
          )
        : null,
    empty: () => [],
    onReadFailure: 'empty',
  })()
  await store.mutate(msgs => [
    ...msgs,
    { from: 'sender', text: 'new message', timestamp: new Date().toISOString(), read: false },
  ])
  const after = readFileSync(storePath, 'utf8')
  const quarantines = readdirSync(tmp).filter(
    f => f.startsWith('fc5-inbox.json.damaged-') && f.endsWith('.recovered'),
  )
  ok(
    after.includes('new message') &&
      quarantines.length === 1 &&
      readFileSync(join(tmp, quarantines[0]!), 'utf8') === DAMAGED,
    'FC5 FIXED: the mutation proceeds only AFTER the only damaged copy is preserved in quarantine (exact bytes)',
  )
}

{
  const listId = 'relia-fc6'
  const tasksDir = join(home, 'tasks', listId)
  const hwm = join(tasksDir, '.highwatermark')
  const SEED = 3000
  let pinned = false
  let survivors = 0
  let liveIds: string[] = []
  for (let round = 0; round < 5 && !pinned; round++) {
    rmSync(tasksDir, { recursive: true, force: true })
    mkdirSync(tasksDir, { recursive: true })
    for (let i = 1; i <= SEED; i++) {
      writeFileSync(
        join(tasksDir, `${i}.json`),
        JSON.stringify({
          id: String(i),
          subject: `seeded ${i}`,
          description: 'pre-reset epoch',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )
    }
    const child = spawn(BUN, ['run', join(HELPERS, 'taskResetKillChild.ts')], {
      env: childEnv({ RELIA_LIST: listId }),
      stdio: 'ignore',
    })
    const exited = new Promise<void>(r => child.once('exit', () => r()))
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (existsSync(hwm)) {
        const left = readdirSync(tasksDir).filter(
          f => f.endsWith('.json') && !f.startsWith('.'),
        ).length
        if (left < SEED - 100) {
          child.kill('SIGKILL')
          break
        }
      }
      if (child.exitCode !== null) break
      await sleep(1)
    }
    await exited
    survivors = readdirSync(tasksDir).filter(
      f => f.endsWith('.json') && !f.startsWith('.'),
    ).length
    if (survivors === 0 || survivors === SEED) continue
    const inspect = runChild('taskListChild.ts', { RELIA_LIST: listId })
    try {
      liveIds = JSON.parse(inspect.stdout.trim().split('\n').pop() ?? '[]')
    } catch {
      liveIds = ['unparseable']
    }
    pinned = liveIds.length === 0
  }
  ok(
    pinned,
    `FC6 FIXED: an interrupted reset resurrects NOTHING — ${survivors} files survived the kill, ${liveIds.length} served as live`,
  )
  const swept = runChild('taskSweepChild.ts', { RELIA_LIST: listId })
  let sweptCount = -1
  try {
    sweptCount = JSON.parse(swept.stdout.trim().split('\n').pop() ?? '-1')
  } catch {
  }
  const remaining = existsSync(tasksDir)
    ? readdirSync(tasksDir).filter(f => f.endsWith('.json') && !f.startsWith('.')).length
    : 0
  ok(
    swept.status === 0 && sweptCount === survivors && remaining === 0,
    `FC6 GC: sweepDeadEpochTasks reclaimed all ${sweptCount} dead bodies`,
  )
  const liveProbe = runChild('taskCreateChild.ts', { RELIA_LIST: listId })
  let probe: { id?: string; live?: string[] } = {}
  try {
    probe = JSON.parse(liveProbe.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
  }
  ok(
    liveProbe.status === 0 && typeof probe.id === 'string' && (probe.live ?? []).includes(probe.id),
    `FC6 LIVENESS: a current-epoch task serves as live (created ${probe.id ?? '?'}, ${probe.live?.length ?? 0} live)`,
  )
}


{
  const storePath = join(tmp, 'fc8-store.json')
  type Counter = { n: number }
  const store = defineStore<Counter, []>({
    name: 'relia-fc8',
    path: () => storePath,
    schemaVersion: 1,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as Counter).n === 'number'
        ? { n: (raw as Counter).n }
        : null,
    empty: () => ({ n: 0 }),
    onReadFailure: 'empty',
    watchDebounceMs: 400,
  })()
  let fixedFc8 = false
  let observed: Array<{ rev: number | null; skipped: number; cause: string }> = []
  for (let round = 0; round < 3 && !fixedFc8; round++) {
    await store.write({ n: 0 })
    observed = []
    const unsub = store.subscribeChanges(
      c =>
        observed.push({
          rev: c.revision?.revision ?? null,
          skipped: c.skippedRevisions,
          cause: c.cause,
        }),
      { immediate: false },
    )
    await sleep(800)
    observed = []
    const res = runChild('storeDoublePublishChild.ts', { RELIA_STORE: storePath })
    await sleep(1400)
    unsub()
    const last = observed.at(-1)
    fixedFc8 =
      res.status === 0 &&
      observed.length === 1 &&
      last?.cause === 'catch-up' &&
      last.skipped === 1 &&
      typeof last.rev === 'number'
  }
  ok(
    fixedFc8,
    `FC8 FIXED: coalesced commits arrive as one catch-up emission with skippedRevisions=1 (${JSON.stringify(observed)})`,
  )
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-interruption-windows' : `\nFAIL prove-interruption-windows (${failures})`)
process.exit(failures === 0 ? 0 : 1)

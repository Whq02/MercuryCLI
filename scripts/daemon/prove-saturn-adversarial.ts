#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'America/New_York'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-adversarial-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-adversarial-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SATURN_DISABLE
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const saturn = await import('../../src/daemon/saturn.ts')
const { applyConcourseScheduleOp } = saturn
const ticker = await import('../../src/daemon/saturnTicker.ts')
const { tickSaturnOnce, DEFAULT_SATURN_CATCHUP_WINDOW_MS } = ticker
const { updateConcourseWorkers, concourseWorkersPath } = await import(
  '../../src/daemon/concourseSupervisor.ts'
)
const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SESSION = 'sess-fixture-1'
const WORKSPACE = '/scratch/fixture-repo'
const HOME = getProjectDir(WORKSPACE)
const FIXTURE_ACCOUNT = {
  family: 'anthropic',
  source: 'oauth' as const,
  scopeDir: join(DAEMON_DIR, 'scope'),
  identity: 'operator@example.com',
  knownExpiresAt: null,
  refreshable: true,
}
const okDeps = {
  deriveAccount: (_modelKey: string) => ({ ok: true as const, account: { ...FIXTURE_ACCOUNT } }),
}

function seedRecord(): void {
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers['concourse-m1'] = {
      schema: 1,
      runnerId: 'concourse-m1',
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  }, DAEMON_DIR)
}

function rawRecord(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as {
    workers: Record<string, Record<string, unknown>>
  }
  return raw.workers['concourse-m1']!
}
const scheduleRows = () => ((rawRecord().schedules ?? []) as Array<Record<string, unknown>>)
const heldRows = () => ((rawRecord().heldFires ?? []) as Array<Record<string, unknown>>)
const receiptRows = (kind: string) => receipts.readSessionReceipts(HOME, SESSION).filter(r => r.kind === kind)

function makePorts(state: {
  nowMs: number
  facts: 'ready' | 'signed-out'
  deliverOk?: boolean
  birthOk?: boolean
  screenOpen?: boolean
  derive?: (modelKey: string) => { ok: true; account: typeof FIXTURE_ACCOUNT } | { ok: false; reason: string }
}) {
  const delivered: Array<{ clientMessageId: string; prompt: string; parked: boolean; sessionId: string }> = []
  const births: Array<{ scheduleId: string; dueAt: number; by: string }> = []
  const derivedKeys: string[] = []
  const ports = {
    now: () => state.nowMs,
    records: () =>
      Object.values(
        (JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, never> }).workers,
      ).filter((r: { endedAt?: number }) => r.endedAt === undefined) as never[],
    liveFacts: () =>
      state.facts === 'ready'
        ? { credentialed: true, stranded: false, expiresAt: null, refreshable: false }
        : { credentialed: false, stranded: false, expiresAt: null, refreshable: false },
    deriveAccount: (modelKey: string) => {
      derivedKeys.push(modelKey)
      return state.derive !== undefined ? state.derive(modelKey) : { ok: true as const, account: { ...FIXTURE_ACCOUNT } }
    },
    deliver: async (d: { clientMessageId: string; prompt: string; parked: boolean; sessionId: string }) => {
      delivered.push(d)
      return { ok: state.deliverOk !== false }
    },
    birth: async (_spec: unknown, opts: { scheduleId: string; dueAt: number; by: string }) => {
      births.push(opts)
      return state.birthOk !== false ? { ok: true, sessionId: `born-${births.length}` } : { ok: false, detail: 'refused (fixture)' }
    },
    screenOpen: () => state.screenOpen !== false,
    dir: DAEMON_DIR,
  } as never
  return { ports, delivered, births, derivedKeys }
}

const addVia = (schedule: unknown): string => {
  const r = applyConcourseScheduleOp(SESSION, { op: 'add', schedule }, 'operator:test', okDeps, DAEMON_DIR)
  if (r.outcome !== 'applied') check('seed add failed', false, r.detail ?? '')
  return r.scheduleId!
}
const backdate = (scheduleId: string, createdAt: number): void => {
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      const row = ((r as { schedules?: Array<Record<string, unknown>> }).schedules ?? []).find(s => s.id === scheduleId)
      if (row) row.createdAt = createdAt
    }
  }, DAEMON_DIR)
}
const clearAll = (): void => {
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
}

console.log('§M2 held-schedule adjudication overlap')
{
  seedRecord()
  const T0 = Date.parse('2026-01-15T12:00:30Z')
  const birthEveryMin = {
    when: { kind: 'every', cron: '* * * * *' },
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-opus-5', presence: 'headless' } },
  }
  const id1 = addVia(birthEveryMin)
  backdate(id1, T0 - 120_000)
  const s1 = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m1 = makePorts(s1)
  const r1 = await tickSaturnOnce(m1.ports)
  check('M2a the due birth holds while signed out (no birth ran)', r1.held === 1 && m1.births.length === 0 && heldRows().length === 1)
  s1.facts = 'ready'
  const r2 = await tickSaturnOnce(m1.ports)
  check('M2a the release tick replays EXACTLY ONCE (one birth, not two)', r2.replayed === 1 && r2.fired === 0 && m1.births.length === 1, `replayed=${r2.replayed} fired=${r2.fired} births=${m1.births.length}`)
  check('M2a one fire receipt rows for the occurrence (never a doubled pair)', receiptRows('schedule-fire').length === 1)
  clearAll()

  const T1 = Date.parse('2026-01-16T12:00:30Z')
  const fireEveryMin = { when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'held debt' } }
  const id2 = addVia(fireEveryMin)
  backdate(id2, T1 - 120_000)
  const s2 = { nowMs: T1, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m2 = makePorts(s2)
  await tickSaturnOnce(m2.ports)
  check('M2b the due fire held (signed-out)', heldRows().length === 1)
  const missedBefore = receiptRows('schedule-fire').filter(r => (r.details as Record<string, unknown>).outcome === 'missed-expired').length
  s2.nowMs = T1 + DEFAULT_SATURN_CATCHUP_WINDOW_MS + 120_000
  const r3 = await tickSaturnOnce(m2.ports)
  const missedAfter = receiptRows('schedule-fire').filter(r => (r.details as Record<string, unknown>).outcome === 'missed-expired').length
  check('M2b a tick past the window rows NO missed-expired while the hold stands', r3.missed === 0 && missedAfter === missedBefore, `missed=${r3.missed}`)
  check('M2b the hold still stands (the banked debt is the record)', heldRows().length === 1)
  s2.facts = 'ready'
  const r4 = await tickSaturnOnce(m2.ports)
  check('M2b the sign-in releases the old debt honestly (fired-late, however old)', r4.replayed === 1 && m2.delivered.length === 1 && heldRows().length === 0)
  clearAll()

  const T2 = Date.parse('2026-01-17T12:00:30Z')
  const id3 = addVia({ when: { kind: 'at', atMs: T2 - 1000 }, action: { kind: 'fire', prompt: 'one-shot debt' } })
  const s3 = { nowMs: T2, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m3 = makePorts(s3)
  await tickSaturnOnce(m3.ports)
  check('M2c the one-shot held', heldRows().length === 1 && scheduleRows().some(s => s.id === id3))
  s3.nowMs = T2 + DEFAULT_SATURN_CATCHUP_WINDOW_MS + 120_000
  await tickSaturnOnce(m3.ports)
  check('M2c past the window the held one-shot is NOT spent (row + hold both stand)', scheduleRows().some(s => s.id === id3) && heldRows().length === 1)
  s3.facts = 'ready'
  const r5 = await tickSaturnOnce(m3.ports)
  check('M2c the release replays the one-shot whole and spends it (row gone, hold gone)', r5.replayed === 1 && m3.delivered.length === 1 && !scheduleRows().some(s => s.id === id3) && heldRows().length === 0)
  clearAll()
}

console.log('§M2x held-schedule adjudication overlap (box tier)')
{
  const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
  const { readBoxSchedules, saturnBoxSchedulesPath } = boxMod
  const writeBox = (schedules: unknown[], heldFires: unknown[] = []): void => {
    writeFileSync(saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules, heldFires }))
  }
  const boxBirthRow = (id: string, when: unknown, createdAt: number) => ({
    schema: 1,
    id,
    when,
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-opus-5', presence: 'headless' } },
    account: { family: 'anthropic', source: 'oauth' },
    modelKey: 'claude-opus-5',
    createdAt,
    createdBy: 'operator:test',
  })
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
  }, DAEMON_DIR)

  const T0 = Date.parse('2026-01-18T12:00:30Z')
  writeBox([boxBirthRow('beef0001', { kind: 'every', cron: '* * * * *' }, T0 - 120_000)])
  const s1 = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m1 = makePorts(s1)
  const r1 = await tickSaturnOnce(m1.ports)
  check('M2x-a the due box birth holds while signed out', r1.held === 1 && m1.births.length === 0 && readBoxSchedules(DAEMON_DIR).heldFires.length === 1)
  s1.facts = 'ready'
  const r2 = await tickSaturnOnce(m1.ports)
  check('M2x-a the release replays EXACTLY ONCE (one box birth, not two)', r2.replayed === 1 && r2.fired === 0 && m1.births.length === 1, `replayed=${r2.replayed} fired=${r2.fired} births=${m1.births.length}`)

  const T1 = Date.parse('2026-01-19T12:00:30Z')
  writeBox([boxBirthRow('beef0002', { kind: 'at', atMs: T1 - 1000 }, T1 - 60_000)])
  const s2 = { nowMs: T1, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m2 = makePorts(s2)
  await tickSaturnOnce(m2.ports)
  check('M2x-b the box one-shot held', readBoxSchedules(DAEMON_DIR).heldFires.length === 1)
  s2.nowMs = T1 + DEFAULT_SATURN_CATCHUP_WINDOW_MS + 120_000
  const r3 = await tickSaturnOnce(m2.ports)
  const boxAfter = readBoxSchedules(DAEMON_DIR)
  check('M2x-b past the window the held box row is neither missed nor spent (row + hold stand)', r3.missed === 0 && boxAfter.schedules.length === 1 && boxAfter.heldFires.length === 1, `missed=${r3.missed} rows=${boxAfter.schedules.length} holds=${boxAfter.heldFires.length}`)
  s2.facts = 'ready'
  const r4 = await tickSaturnOnce(m2.ports)
  const boxDone = readBoxSchedules(DAEMON_DIR)
  check('M2x-b the release replays the box one-shot whole and spends it', r4.replayed === 1 && m2.births.length === 1 && boxDone.schedules.length === 0 && boxDone.heldFires.length === 0)
  writeBox([])
}

console.log('§M3 remove drops the removed schedule\'s holds')
{
  seedRecord()
  const T0 = Date.parse('2026-01-20T12:00:30Z')
  const idA = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'doomed' } })
  const idB = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'survivor' } })
  const s = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m = makePorts(s)
  await tickSaturnOnce(m.ports)
  check('M3 both due fires held', heldRows().length === 2)
  const removed = applyConcourseScheduleOp(SESSION, { op: 'remove', scheduleId: idA }, 'operator:test', okDeps, DAEMON_DIR)
  check('M3 the remove applied', removed.outcome === 'applied')
  check('M3 the removed schedule\'s hold left with it; the sibling\'s stands', heldRows().length === 1 && heldRows()[0]!.scheduleId === idB, `holds=${JSON.stringify(heldRows().map(h => h.scheduleId))}`)
  const removeReceipt = receiptRows('schedule-set').filter(r => (r.details as Record<string, unknown>).op === 'remove').pop()
  check('M3 the remove receipt says the hold was dropped with it', (removeReceipt?.summary ?? '').includes('1 held fire dropped') && (removeReceipt?.details as Record<string, unknown>)?.droppedHolds === 1)
  s.facts = 'ready'
  const r = await tickSaturnOnce(m.ports)
  check('M3 the release replays ONLY the survivor (the removed debt never fires)', r.replayed === 1 && m.delivered.length === 1 && m.delivered[0]!.prompt === 'survivor')
  check('M3 absent ≠ empty after the survivor spends: both fields gone whole (raw file)', !('heldFires' in rawRecord()) && !('schedules' in rawRecord()))
  clearAll()

  const idE = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'e' } })
  const sE = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  await tickSaturnOnce(makePorts(sE).ports)
  check('M3c the lone fire held', heldRows().length === 1)
  applyConcourseScheduleOp(SESSION, { op: 'remove', scheduleId: idE }, 'operator:test', okDeps, DAEMON_DIR)
  check('M3c the remove drops the heldFires field WHOLE (raw file — never a healed [])', !('heldFires' in rawRecord()))
  clearAll()

  const idC = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'c' } })
  const idD = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'd' } })
  const s2 = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  await tickSaturnOnce(makePorts(s2).ports)
  applyConcourseScheduleOp(SESSION, { op: 'remove', scheduleId: idD }, 'operator:test', okDeps, DAEMON_DIR)
  check('M3b the surviving hold rides the kept field', heldRows().length === 1 && heldRows()[0]!.scheduleId === idC)
  clearAll()
}

console.log('§M4 held-line honesty + the L3 flood')
{
  seedRecord()
  const T0 = Date.parse('2026-01-21T09:00:30Z')
  const FLOOD = 12
  const ids: string[] = []
  for (let i = 0; i < FLOOD; i++) {
    ids.push(addVia({ when: { kind: 'at', atMs: T0 - 1000 - i }, action: { kind: 'fire', prompt: `flood-${i}` } }))
  }
  const s = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m = makePorts(s)
  const r1 = await tickSaturnOnce(m.ports)
  check(`M4 one tick held all ${FLOOD} due fires`, r1.held === FLOOD && heldRows().length === FLOOD)
  const floodIds = new Set(ids)
  const heldSummaries = receiptRows('schedule-held')
    .filter(r => floodIds.has((r.details as Record<string, unknown>).scheduleId as string))
    .map(r => r.summary)
  const spoken = heldSummaries.map(t => /releases (\d+) held fire/.exec(t)?.[1]).filter(v => v !== undefined)
  check(
    'M4 the held receipts count 1..N honestly (never "releases 1" repeated)',
    spoken.length === FLOOD && spoken.every((v, i) => Number(v) === i + 1),
    `spoke=[${spoken.join(',')}]`,
  )
  s.facts = 'ready'
  const r2 = await tickSaturnOnce(m.ports)
  check(`L3 one sign-in releases the WHOLE flood in one tick (${FLOOD} replays)`, r2.replayed === FLOOD && m.delivered.length === FLOOD && heldRows().length === 0)
  check(
    'L3 the flood replays IN HOLD ORDER, no stampede duplicate',
    m.delivered.map(d => d.prompt).join(',') === ids.map((_, i) => `flood-${i}`).join(',') &&
      new Set(m.delivered.map(d => d.clientMessageId)).size === FLOOD,
  )
  const lateRows = receiptRows('schedule-fire').filter(
    r => (r.details as Record<string, unknown>).outcome === 'fired-late' && floodIds.has((r.details as Record<string, unknown>).scheduleId as string),
  )
  check('L3 every release is receipted fired-late with its origin', lateRows.length === FLOOD && lateRows.every(r => (r.details as Record<string, unknown>).releasedFrom === 'signed-out'))
  clearAll()
}

console.log('§M5 box heldFires loud-skip (record corruption, L2)')
{
  const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
  const { readBoxSchedules, saturnBoxSchedulesPath } = boxMod
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
  }, DAEMON_DIR)
  const T0 = Date.parse('2026-01-22T12:00:30Z')
  const goodHold = {
    scheduleId: 'cafe0001',
    dueAt: T0 - 1000,
    reason: 'admission-refused',
    envelope: {
      scheduleId: 'cafe0001',
      kind: 'birth',
      dueAt: T0 - 1000,
      birth: { workspaceDir: WORKSPACE, modelKey: 'claude-opus-5', presence: 'headless' },
    },
    heldAt: T0 - 500,
  }
  const goodRow = {
    schema: 1,
    id: 'cafe0001',
    when: { kind: 'every', cron: '0 9 * * *' },
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-opus-5', presence: 'headless' } },
    account: { family: 'anthropic', source: 'oauth' },
    modelKey: 'claude-opus-5',
    createdAt: T0 - 60_000,
    createdBy: 'operator:test',
  }
  writeFileSync(
    saturnBoxSchedulesPath(DAEMON_DIR),
    JSON.stringify({
      version: 1,
      schedules: [goodRow],
      heldFires: [
        null,
        'garbage',
        { scheduleId: 'dead0001' },
        { ...goodHold, scheduleId: 'dead0002', envelope: { scheduleId: 'dead0002', kind: 'fire', dueAt: 1 } },
        goodHold,
      ],
    }),
  )
  const readBack = readBoxSchedules(DAEMON_DIR)
  check('M5 the read keeps ONLY the lawful hold (siblings of the mangled stand)', readBack.heldFires.length === 1 && readBack.heldFires[0]!.scheduleId === 'cafe0001', `kept=${readBack.heldFires.length}`)
  check('M5 the schedules sibling array is untouched by held mangling', readBack.schedules.length === 1)
  const s = { nowMs: T0, facts: 'ready' as 'ready' | 'signed-out' }
  const m = makePorts(s)
  let threw = ''
  let report = { fired: 0, held: 0, missed: 0, replayed: 0 }
  try {
    report = await tickSaturnOnce(m.ports)
  } catch (e) {
    threw = String(e)
  }
  check('M5 the tick stays TOTAL over the mangled file (never throws)', threw === '', threw)
  check('M5 the lawful hold replayed through the corruption (the box tier lives)', report.replayed === 1 && m.births.length === 1)
  writeFileSync(saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))
}

console.log('§M6 owner-scoped idempotency keys (L5)')
{
  const T0 = Date.parse('2026-01-23T09:00:00Z')
  const twinSchedule = {
    schema: 1,
    id: 'feed0001',
    when: { kind: 'at', atMs: T0 - 1000 },
    action: { kind: 'fire', prompt: 'nine sharp' },
    account: { family: 'anthropic', source: 'oauth' },
    modelKey: 'claude-opus-5',
    createdAt: T0 - 60_000,
    createdBy: 'operator:test',
  }
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    for (const [runner, session] of [
      ['concourse-a', 'sess-a'],
      ['concourse-b', 'sess-b'],
    ] as const) {
      workers[runner] = {
        schema: 1,
        runnerId: runner,
        sessionId: session,
        workspaceId: WORKSPACE,
        isolation: 'shared',
        modelKey: 'claude-opus-5',
        spawnedAt: T0 - 60_000,
        lastLiveAt: T0,
        schedules: [structuredClone(twinSchedule)],
      } as never
    }
  }, DAEMON_DIR)
  const s = { nowMs: T0, facts: 'ready' as 'ready' | 'signed-out' }
  const m = makePorts(s)
  const r = await tickSaturnOnce(m.ports)
  check('M6 both sessions fired their twin-keyed schedules', r.fired === 2 && m.delivered.length === 2)
  check(
    'M6 the two fires carry DISTINCT idempotency keys (the ledger is daemon-wide)',
    m.delivered.length === 2 && m.delivered[0]!.clientMessageId !== m.delivered[1]!.clientMessageId,
    `ids=[${m.delivered.map(d => d.clientMessageId).join(' , ')}]`,
  )
  check(
    'M6 each key names its own session',
    m.delivered.every(d => d.clientMessageId.includes(d.sessionId)),
  )
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
  }, DAEMON_DIR)

  const { makeSaturnBirthPort } = await import('../../src/daemon/saturnBirth.ts')
  const seenKeys: string[] = []
  const doors = {
    dispatch: async (req: { clientMessageId: string }) => {
      seenKeys.push(req.clientMessageId)
      return { ok: true, sessionId: 'born-x', workspaceId: WORKSPACE }
    },
    withdraw: async () => true,
    admit: async () => ({ ok: true, runnerId: 'r', sessionId: 'born-y', workspaceId: WORKSPACE }),
    contract: () => ({ outcome: 'applied' as const }),
  }
  const birth = makeSaturnBirthPort(doors as never)
  const spec = { workspaceDir: WORKSPACE, modelKey: 'claude-opus-5', presence: 'headless' as const, opening: 'work' }
  await birth(spec, { scheduleId: 'feed0002', dueAt: 7777, by: 'saturn:feed0002', owner: 'sess-a' } as never)
  await birth(spec, { scheduleId: 'feed0002', dueAt: 7777, by: 'saturn:box:feed0002', owner: 'box' } as never)
  check('M6b the session and box birth keys are distinct for the same (id, dueAt)', seenKeys.length === 2 && seenKeys[0] !== seenKeys[1], `keys=[${seenKeys.join(' , ')}]`)
}

console.log('§M1 the burst cap has one truth')
{
  const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
  const seatMod = await import('../../src/daemon/sessionSeat.ts')
  check(
    'M1 the bridge latch cap IS the seat clip (one bound; the bridge spells it literally to keep the runner graph light)',
    bridge.PENDING_SCHEDULE_EDIT_CAP === saturn.SATURN_EDIT_BURST_CAP,
    `bridge=${bridge.PENDING_SCHEDULE_EDIT_CAP} seat=${(saturn as Record<string, unknown>).SATURN_EDIT_BURST_CAP}`,
  )

  const CAP = bridge.PENDING_SCHEDULE_EDIT_CAP
  const ids = Array.from({ length: CAP + 1 }, (_, i) => `ab${String(i).padStart(6, '0')}`.slice(0, 8))
  const T0 = Date.parse('2026-01-24T12:00:00Z')
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers['concourse-m1'] = {
      schema: 1,
      runnerId: 'concourse-m1',
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      spawnedAt: T0,
      lastLiveAt: T0,
      schedules: ids.map(id => ({
        schema: 1,
        id,
        when: { kind: 'at', atMs: T0 + 86_400_000 },
        action: { kind: 'fire', prompt: 'x' },
        account: { family: 'anthropic', source: 'oauth' },
        modelKey: 'claude-opus-5',
        createdAt: T0,
        createdBy: 'operator:test',
      })),
    } as never
  }, DAEMON_DIR)
  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()
  const outcomes = ids.map(id => bridge.submitSessionScheduleEdit({ op: 'pause', scheduleId: id }))
  const accepted = outcomes.filter(o => o.road === 'seat').length
  const refusedLast = outcomes[CAP]!
  check(`M1 the bridge accepts exactly the cap (${CAP}) and refuses the next TYPED at the source`, accepted === CAP && refusedLast.road === 'refused' && (refusedLast as { reason: string }).reason.includes(String(CAP)))
  const pending = bridge.takePendingScheduleEdits()
  const frames: string[] = []
  const fixtureRoster = {
    control: (_short: string, frame: string) => {
      frames.push(frame)
      return true
    },
    list: () => [{ short: 'concourse-m1', busy: false }],
    patchSeatModel: () => true,
    patchSeatEffort: () => true,
  }
  const answer = {
    model: { effective: 'claude-opus-5', setting: null },
    usage: { totalCostUSD: 0 },
    skills: [],
    mcp: [],
    permissionMode: 'flow',
    workspace: { cwd: WORKSPACE, originalCwd: WORKSPACE, projectRoot: WORKSPACE, instructionRoots: [] },
    queue: [],
    pendingScheduleEdits: pending,
  }
  seatMod.onSeatLine(
    'concourse-m1',
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'mercury-session-facts-concourse-m1-1', response: answer } }),
    fixtureRoster as never,
    DAEMON_DIR,
  )
  const pausedCount = scheduleRows().filter(s => s.paused === true).length
  check(
    `M1 every bridge-ACCEPTED edit landed (${CAP} paused; none accepted-then-dropped)`,
    pending.length === accepted && pausedCount === accepted,
    `pending=${pending.length} paused=${pausedCount}`,
  )
  clearAll()
}

console.log('§M7 the box hold cap has one home')
{
  const src = readFileSync(join(import.meta.dir, '../../src/daemon/saturnBoxSchedules.ts'), 'utf8')
  check('M7 holdBoxFire reads SATURN_HELD_CAP (no literal cap in the box pens)', src.includes('SATURN_HELD_CAP') && !/heldFires\.length >= 200/.test(src))
}

console.log('§M8 the birth derivation key')
{
  const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
  writeFileSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))
  const askedKeys: string[] = []
  const recordingDeps = {
    deriveAccount: (modelKey: string) => {
      askedKeys.push(modelKey)
      return { ok: true as const, account: { ...FIXTURE_ACCOUNT } }
    },
  }
  const birthSub = (topModel?: string) => ({
    when: { kind: 'at', atMs: Date.parse('2026-02-01T09:00:00Z') },
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-fable-5', presence: 'headless' } },
    ...(topModel !== undefined ? { modelKey: topModel } : {}),
  })

  const divergent = boxMod.addBoxSchedule(birthSub('deepseek:deepseek-chat'), 'operator:test', recordingDeps, DAEMON_DIR)
  check('M8 box: a top-level modelKey diverging from the birth refuses typed', divergent.ok === false && !divergent.ok && divergent.reason.includes('birth.modelKey'), JSON.stringify(divergent))
  askedKeys.length = 0
  const plain = boxMod.addBoxSchedule(birthSub(), 'operator:test', recordingDeps, DAEMON_DIR)
  check('M8 box: the account derives from the model the birth RUNS', plain.ok === true && askedKeys.length === 1 && askedKeys[0] === 'claude-fable-5')
  writeFileSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))

  seedRecord()
  askedKeys.length = 0
  const sessDivergent = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: birthSub('deepseek:deepseek-chat') }, 'operator:test', recordingDeps, DAEMON_DIR)
  check('M8 session: a top-level modelKey diverging from the birth refuses typed', sessDivergent.outcome === 'refused' && (sessDivergent.detail ?? '').includes('birth.modelKey'))
  askedKeys.length = 0
  const sessPlain = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: birthSub() }, 'operator:test', recordingDeps, DAEMON_DIR)
  check('M8 session: the birth account derives from birth.modelKey (never the session default)', sessPlain.outcome === 'applied' && askedKeys.length === 1 && askedKeys[0] === 'claude-fable-5')
  const birthRow = scheduleRows().find(s => s.id === sessPlain.scheduleId)
  check('M8 session: the stored row wears the birth model', (birthRow?.modelKey as string) === 'claude-fable-5')
  clearAll()
}

console.log('§M10 the id mint collision guard')
{
  const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
  writeFileSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))
  seedRecord()
  const sequence = ['dddd0001', 'dddd0001', 'dddd0002']
  let cursor = 0
  const collidingDeps = { ...okDeps, mintId: () => sequence[Math.min(cursor++, sequence.length - 1)]! }
  const goodAt = { when: { kind: 'at', atMs: Date.parse('2026-02-02T09:00:00Z') }, action: { kind: 'fire', prompt: 'x' } }
  const first = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: goodAt }, 'operator:test', collidingDeps, DAEMON_DIR)
  const second = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: goodAt }, 'operator:test', collidingDeps, DAEMON_DIR)
  check('M10 a colliding mint re-mints (both adds land, ids distinct)', first.scheduleId === 'dddd0001' && second.scheduleId === 'dddd0002')
  const stuckDeps = { ...okDeps, mintId: () => 'dddd0001' }
  const stuck = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: goodAt }, 'operator:test', stuckDeps, DAEMON_DIR)
  check('M10 a stuck mint refuses typed at the bound (never spins, never collides)', stuck.outcome === 'refused' && (stuck.detail ?? '').includes('unused id'))
  clearAll()

  const birthSub = {
    when: { kind: 'at', atMs: Date.parse('2026-02-02T09:00:00Z') },
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-fable-5', presence: 'headless' as const } },
  }
  cursor = 0
  const b1 = boxMod.addBoxSchedule(birthSub, 'operator:test', collidingDeps, DAEMON_DIR)
  const b2 = boxMod.addBoxSchedule(birthSub, 'operator:test', collidingDeps, DAEMON_DIR)
  check('M10 the box mint guard matches (re-mints past the standing id)', b1.ok === true && b2.ok === true && b1.ok && b2.ok && b1.id === 'dddd0001' && b2.id === 'dddd0002')
  writeFileSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))
}

console.log('§L1 clock adversity')
{
  seedRecord()
  const T0 = Date.parse('2026-01-25T12:00:30Z')
  const id1 = addVia({ when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'steady' } })
  backdate(id1, T0 - 120_000)
  const s = { nowMs: T0, facts: 'ready' as 'ready' | 'signed-out' }
  const m = makePorts(s)
  const a1 = await tickSaturnOnce(m.ports)
  check('L1a the recurring fired once at T', a1.fired === 1 && m.delivered.length === 1)
  s.nowMs = T0 - 3 * 3600_000
  const a2 = await tickSaturnOnce(m.ports)
  check('L1a a 3h BACKWARDS jump fires NOTHING (at-most-once under regression)', a2.fired + a2.held + a2.missed + a2.replayed === 0 && m.delivered.length === 1)
  const a3 = await tickSaturnOnce(m.ports)
  check('L1a the regressed clock stays quiet across ticks (no accrual)', a3.fired === 0 && m.delivered.length === 1)
  s.nowMs = T0 + 90_000
  const a4 = await tickSaturnOnce(m.ports)
  check('L1a the clock passing the stamp fires exactly the next occurrence', a4.fired === 1 && m.delivered.length === 2)
  clearAll()

  const springFrom = Date.parse('2026-03-07T12:00:00-05:00')
  const next230 = saturn.saturnNextFireMs({ kind: 'every', cron: '30 2 * * *' }, springFrom)
  check('L1b the spring-forward day has no 02:30 (next = Mar 9 02:30 EDT)', next230 === Date.parse('2026-03-09T02:30:00-04:00'), `next=${next230 === null ? 'null' : new Date(next230).toISOString()}`)
  const wildSpring = saturn.saturnNextFireMs({ kind: 'every', cron: '30 * * * *' }, Date.parse('2026-03-08T01:45:00-05:00'))
  check('L1b a wildcard hour resumes at the first minute past the gap (03:30 EDT)', wildSpring === Date.parse('2026-03-08T03:30:00-04:00'), `next=${wildSpring === null ? 'null' : new Date(wildSpring).toISOString()}`)

  const fallFirst = saturn.saturnNextFireMs({ kind: 'every', cron: '30 1 * * *' }, Date.parse('2026-10-31T12:00:00-04:00'))
  check('L1c the fall-back day fires the FIRST 01:30 (EDT)', fallFirst === Date.parse('2026-11-01T01:30:00-04:00'), `next=${fallFirst === null ? 'null' : new Date(fallFirst).toISOString()}`)
  const fallSecond = saturn.saturnNextFireMs({ kind: 'every', cron: '30 1 * * *' }, fallFirst!)
  check('L1c the repeated hour never double-fires (next = Nov 2 01:30 EST)', fallSecond === Date.parse('2026-11-02T01:30:00-05:00'), `next=${fallSecond === null ? 'null' : new Date(fallSecond).toISOString()}`)

  const dueNYE = Date.parse('2026-12-31T23:59:00-05:00')
  const idLate = addVia({ when: { kind: 'at', atMs: dueNYE }, action: { kind: 'fire', prompt: 'auld lang syne' } })
  const s2 = { nowMs: dueNYE + 3 * 3600_000 + 60_000, facts: 'ready' as 'ready' | 'signed-out' }
  const m2 = makePorts(s2)
  const d1 = await tickSaturnOnce(m2.ports)
  const lateRow = receiptRows('schedule-fire').filter(r => (r.details as Record<string, unknown>).scheduleId === idLate).pop()
  check('L1d a 3h year-boundary sleep fires late with the honest lateMs', d1.fired === 1 && (lateRow?.details as Record<string, unknown>)?.outcome === 'fired-late' && Math.abs(((lateRow?.details as Record<string, unknown>)?.lateMs as number) - (3 * 3600_000 + 60_000)) < 1000)
  const idMissed = addVia({ when: { kind: 'at', atMs: dueNYE }, action: { kind: 'fire', prompt: 'too late' } })
  const s3 = { nowMs: dueNYE + DEFAULT_SATURN_CATCHUP_WINDOW_MS + 60_000, facts: 'ready' as 'ready' | 'signed-out' }
  const d2 = await tickSaturnOnce(makePorts(s3).ports)
  const missRow = receiptRows('schedule-fire').filter(r => (r.details as Record<string, unknown>).scheduleId === idMissed).pop()
  check('L1d beyond the window the year-boundary fire rows missed-expired', d2.missed === 1 && (missRow?.details as Record<string, unknown>)?.outcome === 'missed-expired')
  clearAll()

  const T5 = Date.parse('2026-01-26T12:00:30Z')
  const id5 = addVia({ when: { kind: 'at', atMs: T5 - 1000 }, action: { kind: 'fire', prompt: 'debt across the jump' } })
  const s5 = { nowMs: T5, facts: 'signed-out' as 'ready' | 'signed-out' }
  const m5 = makePorts(s5)
  await tickSaturnOnce(m5.ports)
  check('L1e the fire held at T', heldRows().length === 1 && scheduleRows().some(r => r.id === id5))
  s5.nowMs = T5 - 3600_000
  const e1 = await tickSaturnOnce(m5.ports)
  check('L1e the hold survives the backwards clock whole (no double, no drop)', e1.fired + e1.missed + e1.replayed === 0 && heldRows().length === 1)
  s5.facts = 'ready'
  const e2 = await tickSaturnOnce(m5.ports)
  check('L1e the release replays the banked debt even on a regressed clock', e2.replayed === 1 && m5.delivered.length === 1 && heldRows().length === 0)
  clearAll()
}

console.log('§S1 the box lock + atomic publish')
{
  const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
  const { utimesSync, rmdirSync: rmd, existsSync } = await import('node:fs')
  writeFileSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))

  const src = readFileSync(join(import.meta.dir, '../../src/daemon/saturnBoxSchedules.ts'), 'utf8')
  const lockWraps = (src.match(/withBoxLock\(dir, \(\) =>/g) ?? []).length
  check('S1a all seven mutators hold the box lock across read→publish', lockWraps === 7, `wraps=${lockWraps}`)
  check('S1a the publish rides durableAtomicPublishSync (no bare writeFileSync)', src.includes('durableAtomicPublishSync(p,') && !src.includes('writeFileSync('))

  const lockPath = boxMod.saturnBoxLockPath(DAEMON_DIR)
  const okDepsBox = { deriveAccount: () => ({ ok: true as const, account: { family: 'anthropic', source: 'oauth' as const } }) }
  const birthSub = {
    when: { kind: 'at', atMs: Date.parse('2026-03-01T09:00:00Z') },
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-fable-5', presence: 'headless' as const } },
  }
  mkdirSync(lockPath)
  const t0 = Date.now()
  const contended = boxMod.addBoxSchedule(birthSub, 'operator:test', okDepsBox, DAEMON_DIR)
  const waited = Date.now() - t0
  check('S1b a fresh holder makes the writer WAIT its bound before the loud break-through', contended.ok === true && waited >= 300, `waited=${waited}ms`)
  check('S1b the lock is released after the mutation (no leak)', !existsSync(lockPath))

  mkdirSync(lockPath)
  const old = (Date.now() - 60_000) / 1000
  utimesSync(lockPath, old, old)
  const t1 = Date.now()
  const pastStale = boxMod.setBoxSchedulePaused(contended.ok ? contended.id : '', true, DAEMON_DIR)
  const fast = Date.now() - t1
  check('S1c a stale holder is broken at once (a crashed writer never wedges the tier)', pastStale === 'applied' && fast < 300, `took=${fast}ms`)
  try {
    rmd(lockPath)
  } catch {
  }
  writeFileSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules: [], heldFires: [] }))
}

console.log('§L2 record corruption (session side)')
{
  const T0 = Date.parse('2026-01-27T12:00:30Z')
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers['w-mangled'] = {
      schema: 1,
      runnerId: 'w-mangled',
      sessionId: 'sess-mangled',
      workspaceId: WORKSPACE,
      isolation: 'shared',
      modelKey: 'm',
      spawnedAt: T0,
      lastLiveAt: T0,
      schedules: 'boo',
      heldFires: [null, 42, { scheduleId: 'ok111111', dueAt: 1, reason: 'signed-out' }],
    } as never
    workers['w-healthy'] = {
      schema: 1,
      runnerId: 'w-healthy',
      sessionId: 'sess-healthy',
      workspaceId: WORKSPACE,
      isolation: 'shared',
      modelKey: 'm',
      spawnedAt: T0,
      lastLiveAt: T0,
      schedules: [
        {
          schema: 1,
          id: 'feed1111',
          when: { kind: 'at', atMs: T0 - 1000 },
          action: { kind: 'fire', prompt: 'healthy fire' },
          account: { family: 'anthropic', source: 'oauth' },
          modelKey: 'm',
          createdAt: T0 - 60_000,
          createdBy: 'operator:test',
        },
      ],
    } as never
  }, DAEMON_DIR)

  const mangledRec = Object.values(
    (JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, unknown> }).workers,
  ).find(r => (r as { runnerId?: string }).runnerId === 'w-mangled')!
  let factsThrew = ''
  let facts: Record<string, unknown> = {}
  try {
    facts = saturn.saturnFactsOf(mangledRec as never, T0) as never
  } catch (e) {
    factsThrew = String(e)
  }
  check('L2s saturnFactsOf is TOTAL over the mangled record (the seat compose lives)', factsThrew === '', factsThrew)
  check('L2s a mangled schedules field projects ABSENT; junk holds still count honestly', !('schedules' in facts) && facts.heldFireCount === 3)

  const s = { nowMs: T0, facts: 'ready' as 'ready' | 'signed-out' }
  const m = makePorts(s)
  let tickThrew = ''
  let report = { fired: 0, held: 0, missed: 0, replayed: 0 }
  try {
    report = await tickSaturnOnce(m.ports)
  } catch (e) {
    tickThrew = String(e)
  }
  check('L2s the tick stays TOTAL over the mangled record (never throws)', tickThrew === '', tickThrew)
  check('L2s the HEALTHY sibling record fired through the corruption', report.fired === 1 && m.delivered.length === 1 && m.delivered[0]!.prompt === 'healthy fire')
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
  }, DAEMON_DIR)
}

console.log('§L4 the four re-homed tools against the new engine')
{
  const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
  const { CronCreateTool } = await import('../../src/tools/ScheduleCronTool/CronCreateTool.ts')
  const { CronDeleteTool } = await import('../../src/tools/ScheduleCronTool/CronDeleteTool.ts')
  const { CronListTool } = await import('../../src/tools/ScheduleCronTool/CronListTool.ts')
  const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')

  seedRecord()
  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()

  const created = await CronCreateTool.call({ cron: '0 9 * * *', prompt: 'nightly audit' } as never, {} as never)
  check('L4 CronCreate submits on the seat road', (created as { data: { submitted: boolean } }).data.submitted === true)
  const createEdits = bridge.takePendingScheduleEdits()
  check('L4 the latched edit is the lawful add shape', createEdits.length === 1 && createEdits[0]!.op === 'add')
  const applied = applyConcourseScheduleOp(SESSION, createEdits[0]!, `model:${SESSION}`, okDeps, DAEMON_DIR)
  check('L4 the edit lands through the one writer', applied.outcome === 'applied')
  const landedId = applied.scheduleId!
  const landed = scheduleRows().find(r => r.id === landedId)!
  check('L4 the landed row: every-kind, the human spelling verbatim', (landed.when as Record<string, unknown>).kind === 'every' && (landed.when as Record<string, unknown>).spelling === 'Every day at 9:00 AM')

  bridge.latchSessionScheduleRoster(saturn.saturnFactsOf({ schedules: [landed] } as never, Date.now()).schedules ?? [])
  const listed = await CronListTool.call({} as never, {} as never)
  const listData = (listed as { data: { schedules: Array<{ id: string }>; rosterKnown: boolean } }).data
  check('L4 CronList speaks the pushed roster with the real id', listData.rosterKnown && listData.schedules.length === 1 && listData.schedules[0]!.id === landedId)

  const deleteOk = await CronDeleteTool.validateInput!({ id: landedId } as never)
  check('L4 CronDelete validates against the roster', deleteOk.result === true)
  await CronDeleteTool.call({ id: landedId } as never, {} as never)
  const removeEdits = bridge.takePendingScheduleEdits()
  const removed = applyConcourseScheduleOp(SESSION, removeEdits[0]!, `model:${SESSION}`, okDeps, DAEMON_DIR)
  check('L4 the removal lands (row gone, field dropped whole)', removed.outcome === 'applied' && !('schedules' in rawRecord()))

  const before = Date.now()
  const woke = await ScheduleWakeupTool.call({ delaySeconds: 90, prompt: 'continue the sweep' } as never, {} as never)
  check("L4 ScheduleWakeup rides the session road when a seat listens", (woke as { data: { road: string } }).data.road === 'session')
  const wakeEdits = bridge.takePendingScheduleEdits()
  const wakeWhen = (wakeEdits[0]!.schedule as { when: { kind: string; atMs: number } }).when
  check('L4 the wake is an at-instant on the minute boundary ≥ now+90s', wakeWhen.kind === 'at' && wakeWhen.atMs >= before + 90_000 && wakeWhen.atMs <= before + 151_000 && wakeWhen.atMs % 60_000 === 0)

  let refusedSecret = ''
  try {
    await ScheduleWakeupTool.call({ delaySeconds: 90, prompt: 'use AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } as never, {} as never)
  } catch (e) {
    refusedSecret = String(e)
  }
  check('L4 a secret-bearing wake prompt refuses typed (persisted with the schedule)', refusedSecret.includes('secret'))

  bridge._resetScheduleBridgeForTesting()
  const wakes: string[] = []
  bridge.registerLocalWakeSink(p => wakes.push(p))
  const local = await ScheduleWakeupTool.call({ delaySeconds: 90, prompt: 'local continue' } as never, {} as never)
  check('L4 a seatless run takes the process-local road', (local as { data: { road: string } }).data.road === 'local')
  bridge._resetScheduleBridgeForTesting()

  const toolFiles = [
    'src/tools/ScheduleCronTool/CronCreateTool.ts',
    'src/tools/ScheduleCronTool/CronDeleteTool.ts',
    'src/tools/ScheduleCronTool/CronListTool.ts',
    'src/tools/ScheduleCronTool/prompt.ts',
    'src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts',
    'src/tools/ScheduleWakeupTool/prompt.ts',
    'src/tools/saturnExemptTools.ts',
  ]
  const offenders: string[] = []
  for (const f of toolFiles) {
    const body = readFileSync(join(import.meta.dir, '../..', f), 'utf8')
    if (new RegExp(['kai','ros'].join('') + '|scheduled_tasks', 'i').test(body)) offenders.push(f)
  }
  check('L4 no retired spelling in any re-homed tool byte', offenders.length === 0, offenders.join(','))
  clearAll()
}

console.log('§M11 the wake reads one clock')
{
  const src = readFileSync(join(import.meta.dir, '../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts'), 'utf8')
  const callBody = src.slice(src.indexOf('async call('), src.indexOf('mapToolResultToToolResultBlockParam'))
  const reads = (callBody.match(/Date\.now\(\)/g) ?? []).length
  check('M11 call() reads Date.now() exactly once (display cron and stored instant share it)', reads === 1, `reads=${reads}`)
}

console.log('§M12 screen-seam boundaries')
{
  const { compileWhenSpelling } = await import('../../src/services/saturn/whenSpelling.ts')
  const beforeMidnight = new Date(2026, 5, 10, 23, 59, 30, 0).getTime()
  const afterMidnight = new Date(2026, 5, 11, 0, 0, 30, 0).getTime()
  const preview = compileWhenSpelling('midnight', beforeMidnight)
  const submit = compileWhenSpelling('midnight', afterMidnight)
  const nextMidnight = new Date(2026, 5, 11, 0, 0, 0, 0).getTime()
  const followingMidnight = new Date(2026, 5, 12, 0, 0, 0, 0).getTime()
  check("M12a 'midnight' previewed at 23:59:30 lands the imminent midnight", preview.ok && preview.ok && preview.when.kind === 'at' && preview.when.atMs === nextMidnight)
  check("M12a the same phrase at 00:00:30 lands the FOLLOWING midnight (each compile lawful at its own now; the submit's is the stored truth)", submit.ok && submit.ok && submit.when.kind === 'at' && submit.when.atMs === followingMidnight)
  check('M12a the boundary divergence is exactly the day the receipt frames', submit.ok && preview.ok && (submit.when as { atMs: number }).atMs - (preview.when as { atMs: number }).atMs === 86_400_000)

  const screenSrc = readFileSync(join(import.meta.dir, '../../src/components/BootSaturnScreen.tsx'), 'utf8')
  check('M12b the in-chat mount floors at 12 and caps at 24 (max(12, min(24, termRows - 2)))', screenSrc.includes('fullScene?.rows ?? Math.max(12, Math.min(24, termRows - 2))'))
}

console.log('§M13 model-facing surfaces census')
{
  const { readdirSync } = await import('node:fs')
  const skillsDir = join(import.meta.dir, '../../src/skills/bundled')
  const offenders: string[] = []
  for (const f of readdirSync(skillsDir)) {
    if (!f.endsWith('.ts')) continue
    const body = readFileSync(join(skillsDir, f), 'utf8')
    if (new RegExp(['kai','ros'].join('') + '|scheduled_tasks', 'i').test(body)) offenders.push(f)
  }
  check('M13 no bundled-skill prompt speaks a retired spelling', offenders.length === 0, offenders.join(','))
  const skill = readFileSync(join(skillsDir, 'scheduleRemoteAgents.ts'), 'utf8')
  check('M13 the schedule skill speaks the session-fact truth (no durable flag)', skill.includes('SESSION FACT on the durable session record') && !skill.includes('durable flag'))
}

console.log('§SF1 the fire-time account resolution (ruling b)')
{
  seedRecord()
  const T0 = Date.parse('2026-02-10T12:00:30Z')
  const NEW_FAMILY_ACCOUNT = { family: 'deepseek', source: 'api-key' as const }

  const idA = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'follow me' } })
  const sA = {
    nowMs: T0,
    facts: 'ready' as 'ready' | 'signed-out',
    derive: (_m: string) => ({ ok: true as const, account: NEW_FAMILY_ACCOUNT as never }),
  }
  const mA = makePorts(sA)
  const rA = await tickSaturnOnce(mA.ports)
  check('SF1a the family-moved fire FIRES on the current account (never a false hold)', rA.fired === 1 && mA.delivered.length === 1)
  const fireReceiptA = receiptRows('schedule-fire').filter(r => (r.details as Record<string, unknown>).scheduleId === idA).pop()
  check("SF1a the receipt NAMES the move (fired on the new family — the session's model moved)", (fireReceiptA?.summary ?? '').includes('deepseek') && (fireReceiptA?.summary ?? '').includes("model moved after scheduling"), fireReceiptA?.summary ?? 'NO RECEIPT')
  clearAll()

  const idB = addVia({ when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'refresh me' } })
  backdate(idB, T0 - 120_000)
  const mB = makePorts(sA)
  await tickSaturnOnce(mB.ports)
  const rowB = scheduleRows().find(r => r.id === idB)
  check('SF1b the recurring follow REFRESHED the stored capture to the fire-time derivation', (rowB?.account as Record<string, unknown> | undefined)?.family === 'deepseek' && (rowB?.account as Record<string, unknown> | undefined)?.source === 'api-key', JSON.stringify(rowB?.account))
  check("SF1b the refreshed row wears the model that actually served (the session's own)", rowB?.modelKey === 'claude-opus-5')
  clearAll()

  const idC = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'hold me' } })
  const sC = {
    nowMs: T0,
    facts: 'ready' as 'ready' | 'signed-out',
    derive: (_m: string) => ({ ok: false as const, reason: 'no-credential:deepseek — /logins connects an account, or /router key deepseek connects an API key' }),
  }
  const mC = makePorts(sC)
  const rC = await tickSaturnOnce(mC.ports)
  check('SF1c a refusing fire-time derivation HOLDS signed-out (never fires, never silent)', rC.held === 1 && mC.delivered.length === 0 && heldRows()[0]?.reason === 'signed-out' && heldRows()[0]?.scheduleId === idC)
  const heldReceiptC = receiptRows('schedule-held').filter(r => (r.details as Record<string, unknown>).scheduleId === idC).pop()
  check('SF1c the hold details carry the derivation refusal (the two-door sentence)', ((heldReceiptC?.details as Record<string, unknown>)?.derivationRefusal as string ?? '').includes('no-credential:deepseek'))
  clearAll()

  const idD = addVia({
    when: { kind: 'at', atMs: T0 - 1000 },
    action: { kind: 'birth', birth: { workspaceDir: WORKSPACE, modelKey: 'claude-fable-5', presence: 'headless' } },
  })
  const mD = makePorts({ nowMs: T0, facts: 'ready' })
  const rD = await tickSaturnOnce(mD.ports)
  check('SF1d the birth fired', rD.fired === 1 && mD.births.length === 1)
  check("SF1d the derivation was asked with the BIRTH's own model, never the session's", mD.derivedKeys.length > 0 && mD.derivedKeys.every(k => k === 'claude-fable-5'), `asked=[${mD.derivedKeys.join(',')}] (session model claude-opus-5)`)
  check('SF1d the schedule id sanity', typeof idD === 'string')
  clearAll()
}

console.log('§SF1x the identity-mismatch arm')
{
  seedRecord()
  const T0 = Date.parse('2026-02-11T12:00:30Z')
  const identityAccount = (identity: string) => ({ ...FIXTURE_ACCOUNT, identity })

  const idE = addVia({ when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'whose fire?' } })
  backdate(idE, T0 - 120_000)
  const sE = {
    nowMs: T0,
    facts: 'ready' as 'ready' | 'signed-out',
    derive: (_m: string) => ({ ok: true as const, account: identityAccount('other@example.com') as never }),
  }
  const mE = makePorts(sE)
  const rE = await tickSaturnOnce(mE.ports)
  check('SF1e a same-family identity switch HOLDS account-mismatch (never a silent jump)', rE.held === 1 && mE.delivered.length === 0 && heldRows()[0]?.reason === 'account-mismatch', `held=${rE.held} reason=${String(heldRows()[0]?.reason)}`)
  check('SF1e the hold banks the mint-time live identity (the fresh-sign-in comparator)', heldRows()[0]?.mismatchIdentity === 'other@example.com')
  const mismatchReceipt = receiptRows('schedule-held').filter(r => (r.details as Record<string, unknown>).scheduleId === idE).pop()
  check('SF1e the ruled sentence, verbatim shape', (mismatchReceipt?.summary ?? '').includes('account-mismatch — this schedule was made under a different anthropic account; /logins or run-now releases on the current one'), mismatchReceipt?.summary ?? 'NO RECEIPT')

  sE.derive = (_m: string) => ({ ok: true as const, account: identityAccount('operator@example.com') as never })
  const rF = await tickSaturnOnce(mE.ports)
  check('SF1f the original identity releases the mismatch hold (replayed whole)', rF.replayed === 1 && mE.delivered.length === 1 && heldRows().length === 0)
  const rowF = scheduleRows().find(r => r.id === idE)
  check('SF1f the capture stands as the original (no refresh on the match road)', (rowF?.account as Record<string, unknown> | undefined)?.identity === 'operator@example.com')
  clearAll()

  const idG = addVia({ when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'rearm me' } })
  backdate(idG, T0 - 120_000)
  const sG = {
    nowMs: T0,
    facts: 'ready' as 'ready' | 'signed-out',
    derive: (_m: string) => ({ ok: true as const, account: identityAccount('other@example.com') as never }),
  }
  const mG = makePorts(sG)
  await tickSaturnOnce(mG.ports)
  check('SF1g the mismatch hold stands', heldRows().length === 1)
  const rG1 = await tickSaturnOnce(mG.ports)
  check('SF1g the UNMOVED mismatched identity never releases (no one-tick speed bump)', rG1.replayed === 0 && heldRows().length === 1)
  sG.derive = (_m: string) => ({ ok: true as const, account: identityAccount('third@example.com') as never })
  const rG2 = await tickSaturnOnce(mG.ports)
  check('SF1g a FRESH identity releases the debt (replayed whole)', rG2.replayed === 1 && mG.delivered.length === 1 && heldRows().length === 0)
  const rowG = scheduleRows().find(r => r.id === idG)
  check('SF1g the release re-armed the capture on the CURRENT identity', (rowG?.account as Record<string, unknown> | undefined)?.identity === 'third@example.com', JSON.stringify(rowG?.account))
  clearAll()

  const idH = addVia({ when: { kind: 'at', atMs: T0 - 1000 }, action: { kind: 'fire', prompt: 'no jumping' } })
  const sH = { nowMs: T0, facts: 'signed-out' as 'ready' | 'signed-out' }
  const mH = makePorts(sH)
  await tickSaturnOnce(mH.ports)
  check('SF1h the fire held signed-out', heldRows()[0]?.reason === 'signed-out')
  sH.facts = 'ready'
  ;(sH as { derive?: unknown }).derive = (_m: string) => ({ ok: true as const, account: identityAccount('other@example.com') as never })
  const rH1 = await tickSaturnOnce(mH.ports)
  check('SF1h ready-under-a-DIFFERENT-identity never releases the ordinary hold', rH1.replayed === 0 && heldRows().length === 1, `replayed=${rH1.replayed}`)
  ;(sH as { derive?: unknown }).derive = undefined
  const rH2 = await tickSaturnOnce(mH.ports)
  check('SF1h the matching identity releases it whole', rH2.replayed === 1 && mH.delivered.length === 1 && heldRows().length === 0)
  clearAll()
}

console.log(failures === 0 ? '\nprove-saturn-adversarial: ALL GREEN' : `\nprove-saturn-adversarial: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

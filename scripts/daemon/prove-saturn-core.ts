#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-saturn-core.ts — SATURN §A: the schema, the store,
// and the record's ONE WRITER (the founding law).
//
//  Laws pinned here, poison-first:
//   · the validator refuses TYPED before any lawful road (malformed when/
//     action/birth/caps; stray sibling stamps DROPPED — the wire can never
//     write the daemon's id/account/preflight);
//   · a stored schedule carries its FIRST-CLASS ACCOUNT from the injected
//     derivation — derivation failure refuses the add and writes NOTHING;
//   · ABSENT ≠ EMPTY: refusals never materialize the field; the last
//     remove drops the field WHOLE (raw-file pinned, never a healed []);
//   · pause/resume/remove semantics with honest noops; the 51st refuses;
//   · preflightAtWrite stamps ONLY when the preflight is wired (absent is
//     never read as 'ready');
//   · an ENDED record never takes a write;
//   · next-fire math totality; the one-writer census (every `.schedules =`/
//     `.heldFires =` assignment in the tree lives in daemon/saturn.ts).
//
//  cpu-pure: scratch config home + scratch daemon dir; zero spawns, zero
//  daemons, zero PTYs. The account resolver and preflight are FIXTURES —
//  the injected-deps seam is the module's own design for exactly this.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-saturn-core.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-core-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-core-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
// §P determinism: the real-body derivation check drives a keyless engine
// family — scrub its env door so a developer shell's key can't flip it.
delete process.env.DEEPSEEK_API_KEY
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const saturn = await import('../../src/daemon/saturn.ts')
const {
  validateSaturnSubmission,
  applyConcourseScheduleOp,
  saturnNextFireMs,
  describeWhen,
  SATURN_ID_PATTERN,
  SATURN_SCHEDULE_CAP,
  SATURN_PROMPT_CAP,
} = saturn
const { updateConcourseWorkers, concourseWorkersPath } = await import(
  '../../src/daemon/concourseSupervisor.ts'
)
const { parseCronExpression, computeNextCronRun } = await import('../../src/utils/cron.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── fixtures ────────────────────────────────────────────────────────────────
const SESSION = 'sess-saturn-1'
const FIXTURE_ACCOUNT = {
  family: 'anthropic',
  source: 'oauth' as const,
  scopeDir: join(DAEMON_DIR, 'scope'),
  identity: 'operator@example.com',
  knownExpiresAt: Date.now() + 86_400_000,
  refreshable: true,
}
const okDeps = {
  deriveAccount: (_modelKey: string) => ({ ok: true as const, account: { ...FIXTURE_ACCOUNT } }),
}
const refusingDeps = {
  deriveAccount: (_modelKey: string) => ({
    ok: false as const,
    reason: "no-credential:anthropic — /logins connects an account, or /router key connects an API key",
  }),
}

function seedRecord(): void {
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers['concourse-w1'] = {
      schema: 1,
      runnerId: 'concourse-w1',
      sessionId: SESSION,
      workspaceId: '/scratch/repo',
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
    // The ended-record poison: a DEAD record owning the same session id
    // must never take a write (the writer targets endedAt === undefined).
    workers['concourse-w0'] = {
      schema: 1,
      runnerId: 'concourse-w0',
      sessionId: SESSION,
      workspaceId: '/scratch/repo',
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      spawnedAt: Date.now() - 1000,
      lastLiveAt: Date.now() - 1000,
      endedAt: Date.now() - 500,
    } as never
  }, DAEMON_DIR)
}

function rawRecord(runnerId = 'concourse-w1'): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as {
    workers: Record<string, Record<string, unknown>>
  }
  return raw.workers[runnerId]!
}

const goodFire = { kind: 'fire', prompt: 'run the nightly audit' }
const goodAt = { kind: 'at', atMs: Date.now() + 3_600_000 }

// ── §A0 the validator refuses typed, poison-first ───────────────────────────
console.log('§A0 validator poisons')
{
  const cases: Array<[string, unknown]> = [
    ['non-object submission', 42],
    ['unknown when.kind', { when: { kind: 'someday' }, action: goodFire }],
    ['at with zero atMs', { when: { kind: 'at', atMs: 0 }, action: goodFire }],
    ['at with fractional atMs', { when: { kind: 'at', atMs: 1.5 }, action: goodFire }],
    ['every with malformed cron', { when: { kind: 'every', cron: 'not a cron' }, action: goodFire }],
    ['fire with empty prompt', { when: goodAt, action: { kind: 'fire', prompt: '   ' } }],
    ['fire past the prompt cap', { when: goodAt, action: { kind: 'fire', prompt: 'x'.repeat(SATURN_PROMPT_CAP + 1) } }],
    ['fire with bogus onParked', { when: goodAt, action: { ...goodFire, onParked: 'ignore' } }],
    ['unknown action.kind', { when: goodAt, action: { kind: 'ping' } }],
    ['birth without workspaceDir', { when: goodAt, action: { kind: 'birth', birth: { modelKey: 'm', presence: 'headless' } } }],
    ['birth with bogus presence', { when: goodAt, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'sometimes' } } }],
    ['birth with empty kitPreset', { when: goodAt, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'headless', kitPreset: '  ' } } }],
    ['birth contract without text', { when: goodAt, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'headless', contract: {} } } }],
    ['malformed note', { when: goodAt, action: goodFire, note: 'x'.repeat(501) }],
  ]
  for (const [label, raw] of cases) {
    const v = validateSaturnSubmission(raw)
    check(`refuses ${label}`, !v.ok && typeof (v as { reason?: string }).reason === 'string' && (v as { reason: string }).reason.length > 0)
  }
  const withStrays = validateSaturnSubmission({
    when: goodAt,
    action: goodFire,
    id: 'deadbeef',
    account: { family: 'smuggled', source: 'api-key' },
    preflightAtWrite: { state: 'ready' },
    createdBy: 'smuggler',
  })
  check('stray sibling stamps are dropped, submission still lawful', withStrays.ok)
  if (withStrays.ok) {
    const keys = Object.keys(withStrays.submission)
    check(
      'validated submission carries only its own fields',
      !keys.includes('id') && !keys.includes('account') && !keys.includes('preflightAtWrite') && !keys.includes('createdBy'),
      keys.join(','),
    )
  }
  const nullContract = validateSaturnSubmission({
    when: goodAt,
    action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'screen-present', contract: null } },
  })
  check('birth contract: null (no-contract) is lawful ground', nullContract.ok)
}

// ── §A1 the one writer ──────────────────────────────────────────────────────
console.log('§A1 the writer')
{
  // Unknown session, empty store.
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
  }, DAEMON_DIR)
  const none = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: { when: goodAt, action: goodFire } }, 'operator:test', okDeps, DAEMON_DIR)
  check('unknown session refuses typed', none.outcome === 'refused' && (none.detail ?? '').includes('unknown-session'))

  seedRecord()
  // A malformed add against a live record writes NOTHING (absent ≠ empty).
  const badAdd = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: { when: goodAt, action: { kind: 'fire', prompt: '' } } }, 'operator:test', okDeps, DAEMON_DIR)
  check('malformed add refuses typed at the writer', badAdd.outcome === 'refused' && (badAdd.detail ?? '').startsWith('schedule refused — '))
  check('a refused add materializes NO field', !('schedules' in rawRecord()))

  // Derivation refusal: typed, nothing written.
  const noAccount = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: { when: goodAt, action: goodFire } }, 'operator:test', refusingDeps, DAEMON_DIR)
  check('account-derivation failure refuses typed', noAccount.outcome === 'refused' && (noAccount.detail ?? '').includes('no-credential:anthropic'))
  check('a derivation refusal writes nothing', !('schedules' in rawRecord()))

  // Refusal ops on an absent field never heal it.
  for (const op of ['pause', 'resume', 'remove'] as const) {
    const r = applyConcourseScheduleOp(SESSION, { op, scheduleId: 'aaaaaaaa' }, 'operator:test', okDeps, DAEMON_DIR)
    check(`${op} on an absent field refuses (unknown-schedule)`, r.outcome === 'refused' && (r.detail ?? '').includes('unknown-schedule'))
  }
  check('refusal ops never materialized the field', !('schedules' in rawRecord()))
  const badId = applyConcourseScheduleOp(SESSION, { op: 'pause', scheduleId: 'NOT-HEX!' }, 'operator:test', okDeps, DAEMON_DIR)
  check('a malformed scheduleId refuses on its grammar', badId.outcome === 'refused' && (badId.detail ?? '').includes('eight hex'))

  // The lawful add: stamps, defaults, the account.
  const smuggled = {
    when: { kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' },
    action: goodFire,
    account: { family: 'smuggled', source: 'api-key' },
    preflightAtWrite: { state: 'ready' },
  }
  const added = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: smuggled }, 'model:sess-saturn-1', okDeps, DAEMON_DIR)
  check('lawful add applies with the minted id', added.outcome === 'applied' && typeof added.scheduleId === 'string' && SATURN_ID_PATTERN.test(added.scheduleId ?? ''))
  const rec1 = rawRecord()
  const rows = (rec1.schedules ?? []) as Array<Record<string, unknown>>
  check('the field materialized with exactly one row', Array.isArray(rec1.schedules) && rows.length === 1)
  const row = rows[0]!
  check('the row is schema 1 with the minted id', row.schema === 1 && row.id === added.scheduleId)
  check('modelKey defaulted from the session record', row.modelKey === 'claude-opus-5')
  check('effort defaulted from the session record', row.effort === 'high')
  check('createdBy carries the asker', row.createdBy === 'model:sess-saturn-1')
  check('createdAt stamped now-ish', typeof row.createdAt === 'number' && Math.abs(Date.now() - (row.createdAt as number)) < 60_000)
  const acct = row.account as Record<string, unknown>
  check(
    'THE ACCOUNT is the DERIVED one — the smuggled wire account never lands',
    acct.family === 'anthropic' && acct.source === 'oauth' && acct.identity === 'operator@example.com' && acct.refreshable === true,
  )
  check('preflightAtWrite ABSENT when no preflight is wired (absent ≠ ready)', !('preflightAtWrite' in row))
  check('the spelling rides verbatim', (row.when as Record<string, unknown>).spelling === 'every day 09:00')
  check('heldFires never appears from schedule ops', !('heldFires' in rec1))

  // Preflight wiring: the verdict stamps; the fn hears the true next fire.
  let heardNext: number | null = -1
  const preflightDeps = {
    ...okDeps,
    preflight: (_a: unknown, nextFireMs: number | null) => {
      heardNext = nextFireMs
      return { state: 'expiring', expiresAt: 123, beforeFire: true } as const
    },
  }
  const oneShot = { when: { kind: 'at', atMs: Date.now() + 7_200_000 }, action: goodFire }
  const added2 = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: oneShot }, 'operator:test', preflightDeps, DAEMON_DIR)
  check('second add applies', added2.outcome === 'applied')
  const row2 = ((rawRecord().schedules ?? []) as Array<Record<string, unknown>>).find(r => r.id === added2.scheduleId)!
  const verdict = row2.preflightAtWrite as Record<string, unknown> | undefined
  check('preflightAtWrite stamps the wired verdict', verdict?.state === 'expiring' && verdict?.beforeFire === true)
  check('the preflight heard the schedule\'s own next fire', heardNext === (oneShot.when as { atMs: number }).atMs)

  // pause / resume semantics.
  const id2 = added2.scheduleId!
  const paused = applyConcourseScheduleOp(SESSION, { op: 'pause', scheduleId: id2 }, 'operator:test', okDeps, DAEMON_DIR)
  check('pause applies', paused.outcome === 'applied')
  check('the row wears paused: true', ((rawRecord().schedules as Array<Record<string, unknown>>).find(r => r.id === id2)!).paused === true)
  const pausedAgain = applyConcourseScheduleOp(SESSION, { op: 'pause', scheduleId: id2 }, 'operator:test', okDeps, DAEMON_DIR)
  check('pause again is an honest noop', pausedAgain.outcome === 'noop')
  const resumed = applyConcourseScheduleOp(SESSION, { op: 'resume', scheduleId: id2 }, 'operator:test', okDeps, DAEMON_DIR)
  check('resume applies', resumed.outcome === 'applied')
  check('resume DELETES the pause key (absent, never false)', !('paused' in (rawRecord().schedules as Array<Record<string, unknown>>).find(r => r.id === id2)!))
  const resumedAgain = applyConcourseScheduleOp(SESSION, { op: 'resume', scheduleId: id2 }, 'operator:test', okDeps, DAEMON_DIR)
  check('resume again is an honest noop', resumedAgain.outcome === 'noop')

  // remove: one of two keeps the field; the LAST remove drops it WHOLE.
  const removedOne = applyConcourseScheduleOp(SESSION, { op: 'remove', scheduleId: id2 }, 'operator:test', okDeps, DAEMON_DIR)
  check('remove one of two applies', removedOne.outcome === 'applied')
  check('one row remains, field present', ((rawRecord().schedules ?? []) as unknown[]).length === 1)
  const removedLast = applyConcourseScheduleOp(SESSION, { op: 'remove', scheduleId: added.scheduleId! }, 'operator:test', okDeps, DAEMON_DIR)
  check('remove the last applies', removedLast.outcome === 'applied')
  check('THE LAST REMOVE DROPS THE FIELD WHOLE (raw file — never a healed [])', !('schedules' in rawRecord()))

  // The cap: the 51st refuses.
  for (let i = 0; i < SATURN_SCHEDULE_CAP; i++) {
    const r = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: { when: goodAt, action: goodFire } }, 'operator:test', okDeps, DAEMON_DIR)
    if (r.outcome !== 'applied') {
      check(`seeding to the cap failed at ${i}`, false, r.detail ?? '')
      break
    }
  }
  const over = applyConcourseScheduleOp(SESSION, { op: 'add', schedule: { when: goodAt, action: goodFire } }, 'operator:test', okDeps, DAEMON_DIR)
  check('the cap refuses the 51st, typed', over.outcome === 'refused' && (over.detail ?? '').includes(String(SATURN_SCHEDULE_CAP)))
  check('the cap held the count', ((rawRecord().schedules ?? []) as unknown[]).length === SATURN_SCHEDULE_CAP)

  // The ended-record poison: only the LIVE record took every write above.
  check('the ended record with the same session id took NO write', !('schedules' in rawRecord('concourse-w0')))
}

// ── §A2 next-fire math + words ──────────────────────────────────────────────
console.log('§A2 next-fire math')
{
  const future = Date.now() + 1000
  check("'at' in the future answers atMs", saturnNextFireMs({ kind: 'at', atMs: future }, Date.now()) === future)
  check("'at' in the past answers null (a spent one-shot)", saturnNextFireMs({ kind: 'at', atMs: 1000 }, Date.now()) === null)
  const from = new Date('2026-08-29T12:03:00Z')
  const mine = saturnNextFireMs({ kind: 'every', cron: '*/5 * * * *' }, from.getTime())
  const theirs = computeNextCronRun(parseCronExpression('*/5 * * * *')!, from)?.getTime() ?? null
  check("'every' matches the cron engine's own next-run", mine !== null && mine === theirs)
  check('describeWhen echoes the spelling verbatim', describeWhen({ kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' }) === 'every day 09:00')
  check("describeWhen names a spelling-less cron", describeWhen({ kind: 'every', cron: '0 9 * * *' }) === "on '0 9 * * *'")
  check('describeWhen names a one-shot instant', describeWhen({ kind: 'at', atMs: Date.parse('2026-09-01T09:00:00Z') }).includes('2026-09-01T09:00:00'))
}

// ── §P the preflight owner (saturnAccount) ──────────────────────────────────
console.log('§P the preflight owner')
{
  const acct = await import('../../src/daemon/saturnAccount.ts')
  const { deriveScheduleAccountForModel, scheduleAccountVerdict, readLiveAccountFacts, noCredentialRefusal } = acct

  // P1 REAL BODY, deterministic on the scratch home (the family env was
  // scrubbed above; the scratch home holds no stored provider secret): a
  // keyless engine family refuses TYPED with BOTH L26 doors named. The
  // deepseek row's answer never consults the keychain — the snapshot build
  // may still emit one read-only macOS `security` miss line for the
  // ANTHROPIC row it composes alongside (a box fact that cannot flip this
  // family's verdict). The anthropic ARMS ride fixtures below for exactly
  // that reason.
  // RE-PINNED at the route-neutrality fold: the scenario key is the model
  // ID the picker actually stores ('deepseek-chat'), not a family-colon
  // spelling — the old 'deepseek:deepseek-chat' matched NO declared family
  // and rode the retired everything-else-is-anthropic remainder, so this
  // leg silently preflighted the WRONG family's credentials. A malformed
  // key now refuses 'unknown-family' honestly, pinned below.
  const real = deriveScheduleAccountForModel('deepseek-chat')
  check('real-body keyless family refuses (never throws)', real.ok === false)
  if (!real.ok) {
    check('the refusal names BOTH doors (L26)', real.reason.includes('/logins') && real.reason.includes('/router key'))
    check('the refusal is the typed no-credential class', real.reason.startsWith('no-credential:'))
    check('the refusal preflights the KEY\'S OWN family (deepseek, never a remainder)', real.reason.includes('deepseek'))
  }
  const malformed = deriveScheduleAccountForModel('deepseek:deepseek-chat')
  check('a key no family declares refuses unknown-family (the dead remainder cannot class it)', malformed.ok === false && !malformed.ok && malformed.reason.startsWith('unknown-family:'))
  check('noCredentialRefusal spells the family into both doors', noCredentialRefusal('openai').includes('/router key openai'))

  // P2 the anthropic oauth capture, whole (fixtures).
  const EXP = Date.now() + 3_600_000
  const oauthReads = {
    presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
    anthropicDetail: () => ({
      subscriber: true,
      scopeDir: '/scratch/scope-a',
      identity: 'op@example.com',
      knownExpiresAt: EXP,
      refreshable: true,
    }),
  }
  const oauth = deriveScheduleAccountForModel('claude-opus-5', oauthReads)
  check('anthropic oauth derives ok', oauth.ok === true)
  if (oauth.ok) {
    const a = oauth.account
    check(
      'the capture is whole: family/source/scope/identity/expiry/refreshable',
      a.family === 'anthropic' && a.source === 'oauth' && a.scopeDir === '/scratch/scope-a' && a.identity === 'op@example.com' && a.knownExpiresAt === EXP && a.refreshable === true,
    )
    const allowed = new Set(['family', 'source', 'scopeDir', 'identity', 'knownExpiresAt', 'refreshable'])
    check('WHO-NEVER-A-TOKEN: only schema keys ride the capture', Object.keys(a).every(k => allowed.has(k)), Object.keys(a).join(','))
    const spelled = JSON.stringify(a)
    check('nothing token-shaped in the capture spelling', !/accessToken|refreshToken|apiKey|secret/i.test(spelled))
  }

  // P3 the anthropic key arm: oauth fields ABSENT, not null-stuffed.
  const keyed = deriveScheduleAccountForModel('claude-opus-5', {
    presenceOf: () => ({ credentialed: true, kind: 'api-key' as const }),
    anthropicDetail: () => {
      throw new Error('the key arm must never read oauth detail')
    },
  })
  check('anthropic api-key derives ok', keyed.ok === true)
  if (keyed.ok) {
    check(
      'the key capture is exactly {family, source} (oauth facts absent)',
      keyed.account.family === 'anthropic' && keyed.account.source === 'api-key' && Object.keys(keyed.account).length === 2,
    )
  }

  // P4/P5 engine families + totality.
  const engineOauth = deriveScheduleAccountForModel('openai:gpt-oss', {
    familyOf: () => 'openai',
    presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
  })
  check('an engine-family oauth kind derives source oauth', engineOauth.ok === true && engineOauth.ok && engineOauth.account.source === 'oauth' && engineOauth.account.family === 'openai')
  const engineNone = deriveScheduleAccountForModel('m', { familyOf: () => 'zai', presenceOf: () => ({ credentialed: false, kind: 'none' as const }) })
  check('an uncredentialed family refuses the L26 sentence', engineNone.ok === false && !engineNone.ok && engineNone.reason === noCredentialRefusal('zai'))
  const noFamily = deriveScheduleAccountForModel('m', { familyOf: () => '' })
  check('an unanswerable family refuses unknown-family (total)', noFamily.ok === false && !noFamily.ok && noFamily.reason.startsWith('unknown-family'))

  // P6 THE ONE VERDICT's laws (pure; severity order poison-first).
  const NOW = Date.now()
  const FIRE = NOW + 7_200_000
  const base = { credentialed: true, stranded: false, expiresAt: null, refreshable: false }
  const v = (source: 'oauth' | 'api-key', nextFireMs: number | null, live: Partial<typeof base> & { rateLimitedUntil?: number }) =>
    scheduleAccountVerdict({ account: { source }, nextFireMs, nowMs: NOW, live: { ...base, ...live } })
  check('signed-out beats everything', v('oauth', FIRE, { credentialed: false, stranded: true, rateLimitedUntil: NOW + 99 }).state === 'signed-out')
  check('stranded → expired (beats a limit window)', v('oauth', FIRE, { stranded: true, rateLimitedUntil: NOW + 99 }).state === 'expired')
  const limited = v('oauth', FIRE, { rateLimitedUntil: NOW + 60_000 })
  check('a standing limit window → rate-limited with retryAt', limited.state === 'rate-limited' && limited.state === 'rate-limited' && limited.retryAt === NOW + 60_000)
  check('a PAST limit window falls through to ready', v('oauth', FIRE, { rateLimitedUntil: NOW - 1 }).state === 'ready')
  check('THE REFRESHABLE-EXPIRY LAW: expiry before the fire WITH a refresh token = ready', v('oauth', FIRE, { expiresAt: NOW + 60_000, refreshable: true }).state === 'ready')
  const expiring = v('oauth', FIRE, { expiresAt: NOW + 60_000 })
  check('a refreshless expiry at/before the fire warns expiring{beforeFire}', expiring.state === 'expiring' && expiring.state === 'expiring' && expiring.expiresAt === NOW + 60_000 && expiring.beforeFire === true)
  check('an expiry AFTER the fire is ready (no idle warn)', v('oauth', FIRE, { expiresAt: FIRE + 1 }).state === 'ready')
  check('an api-key source never speaks expiring', v('api-key', FIRE, { expiresAt: NOW + 60_000 }).state === 'ready')
  check('no computable next fire → never expiring', v('oauth', null, { expiresAt: NOW + 60_000 }).state === 'ready')

  // P7 the live-facts assembly (injected reads; the non-anthropic arm must
  // never touch the anthropic readers).
  let strandedAsked = 0
  let detailAsked = 0
  const facts = readLiveAccountFacts(
    { family: 'anthropic', source: 'oauth' },
    {
      presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
      strandedNow: () => {
        strandedAsked++
        return false
      },
      anthropicDetail: () => {
        detailAsked++
        return { subscriber: true, scopeDir: '/s', knownExpiresAt: EXP, refreshable: true }
      },
      rateLimitedUntilOf: () => NOW + 5_000,
    },
  )
  check('the assembly maps presence/expiry/refresh/limit', facts.credentialed && facts.expiresAt === EXP && facts.refreshable === true && facts.rateLimitedUntil === NOW + 5_000)
  check('the anthropic arm consulted its readers once each', strandedAsked === 1 && detailAsked === 1)
  const engineFacts = readLiveAccountFacts(
    { family: 'deepseek', source: 'api-key' },
    {
      presenceOf: () => ({ credentialed: true, kind: 'api-key' as const }),
      strandedNow: () => {
        throw new Error('non-anthropic must not ask stranded')
      },
      anthropicDetail: () => {
        throw new Error('non-anthropic must not ask oauth detail')
      },
    },
  )
  check('the engine-family assembly never touches the anthropic readers', engineFacts.credentialed && engineFacts.stranded === false && engineFacts.expiresAt === null)
}

// ── §W the wire (S2): appended last · outside the window · server narrows ──
console.log('§W the wire')
{
  const read = (p: string): string => readFileSync(join(import.meta.dir, '../..', p), 'utf8')
  const protocol = read('src/daemon/protocol.ts')
  const actionsAt = protocol.indexOf("op: 'sessionControl'", protocol.indexOf('export type DaemonRequest ='))
  const window = protocol.slice(protocol.indexOf('action:', actionsAt), protocol.indexOf('sessionId: string', actionsAt))
  check("W1 'set-schedule' is APPENDED LAST in the union (after 'set-kit'; source order is the shape)", /\|\s*'set-kit'\s*\|\s*'set-schedule'\s*$/m.test(window.trimEnd()))
  check('W2 the payload rides OUTSIDE the action window, typed off ScheduleOpRequestV1', !window.includes('scheduleEdit') && protocol.includes("scheduleEdit?: import('./saturn.js').ScheduleOpRequestV1"))
  // W3 re-anchored off the literal: the daemon-wire re-registration bumped
  // the proto (3 → 4, shape re-registered at its owner) — the schedule verb
  // itself forced no bump then and forces none now; bump DISCIPLINE lives
  // in prove-protocol-shape. This pin keeps the constant single-sourced,
  // spelling the value the wire actually exports, beside its registered
  // shape row.
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  check('W3 ONE wire proto beside its registered shape (bump discipline is prove-protocol-shape\'s)', (protocol.match(/export const MERCURY_DAEMON_PROTO = /g) ?? []).length === 1 && protocol.includes(`export const MERCURY_DAEMON_PROTO = ${MERCURY_DAEMON_PROTO}`) && protocol.includes("export const DAEMON_PROTO_SHAPE = 'sha256:"))

  const server = read('src/daemon/controlServer.ts')
  const controlArm = server.slice(server.indexOf("case 'sessionControl': {"), server.indexOf("case 'sessionList': {"))
  // W4's requires-string tail grew '|set-spawn-switch' (bc6a8fa, the seat's
  // spawn-switch door).
  check(
    "W4 the server routes the action and narrows: op grammar · 'add' through validateSaturnSubmission ('scheduleEdit refused — <reason>') · the id grammar · the typed forward · the requires-string",
    controlArm.includes("raw.action === 'set-schedule'") &&
      controlArm.includes('validateSaturnSubmission(rawSchedule.schedule)') &&
      controlArm.includes('scheduleEdit refused — ') &&
      controlArm.includes('SATURN_ID_PATTERN.test(scheduleId)') &&
      controlArm.includes('...(scheduleEdit !== undefined ? { scheduleEdit } : {})') &&
      controlArm.includes('contract|set-kit|set-schedule|set-spawn-switch, sessionId, by }'),
  )

  const main = read('src/daemon/main.ts')
  const arm = main.slice(main.indexOf("if (action === 'set-schedule')"), main.indexOf("if (action === 'set-kit')"))
  check(
    'W5 the daemon arm wires THE REAL RESOLVERS into the one writer and rides settle',
    arm.includes('applyConcourseScheduleOp(sessionId, scheduleEdit, by') &&
      arm.includes('deriveAccount: deriveScheduleAccountForModel') &&
      arm.includes('scheduleAccountVerdict(') &&
      arm.includes('readLiveAccountFacts(account)') &&
      arm.includes('return settle('),
  )
  check('W6 a payload-less set-schedule refuses with the requires sentence', arm.includes("'set-schedule requires { scheduleEdit: { op, schedule? | scheduleId? } }'"))

  // W7 THE RECEIPT, DRIVEN: an applied add rows kind 'schedule-set' in the
  // session's own receipts (the writer's fail-soft pen), and the viewer
  // names the schedule family.
  seedRecord()
  const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const wAdd = applyConcourseScheduleOp(
    SESSION,
    { op: 'add', schedule: { when: { kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' }, action: goodFire } },
    'operator:test',
    okDeps,
    DAEMON_DIR,
  )
  check('W7 the driven add applied', wAdd.outcome === 'applied')
  const home = getProjectDir('/scratch/repo')
  const rows = receipts.readSessionReceipts(home, SESSION).filter(r => r.kind === 'schedule-set')
  const last = rows[rows.length - 1]
  check('W7 the receipt row landed with the op facts', last !== undefined && (last.details as Record<string, unknown> | undefined)?.op === 'add' && (last.details as Record<string, unknown>)?.family === 'anthropic' && last.by === 'operator:test')
  check("W7 the row's words name the spelling", (last?.summary ?? '').includes('every day 09:00'))
  const kindUnionLine = read('src/services/switchboard/sessionReceipts.ts')
  check("W8 the kind union carries 'schedule-set'", kindUnionLine.includes("| 'schedule-set'"))
  const mirror = read('src/components/concourse/SessionMirror.tsx')
  check('W9 the viewer names the schedule family (never the contract fallback)', mirror.includes("e.kind === 'schedule-set'") && mirror.includes('`schedule: ${flat}`'))

  // W10 the facts projection: absent-preserving rows + the seat composes it.
  const bare = saturn.saturnFactsOf({}, Date.now())
  check('W10 a schedule-less record projects NO fields (absent ≠ empty on the wire)', !('schedules' in bare) && !('heldFireCount' in bare))
  const NOWW = Date.now()
  const projected = saturn.saturnFactsOf(
    {
      schedules: [
        { schema: 1, id: 'aaaa1111', when: { kind: 'at', atMs: NOWW + 60_000, spelling: 'in a minute' }, action: { kind: 'fire', prompt: 'x' }, account: { family: 'anthropic', source: 'oauth' }, modelKey: 'm', createdAt: NOWW, createdBy: 'operator:test' },
        { schema: 1, id: 'bbbb2222', when: { kind: 'every', cron: '0 9 * * *' }, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'headless' } }, account: { family: 'anthropic', source: 'api-key' }, modelKey: 'm', createdAt: NOWW, createdBy: 'operator:test', paused: true },
      ],
      heldFires: [{ scheduleId: 'aaaa1111', dueAt: NOWW, reason: 'sign-in-expired', envelope: { scheduleId: 'aaaa1111', kind: 'fire', dueAt: NOWW, prompt: 'x' }, heldAt: NOWW }],
    },
    NOWW,
  )
  check(
    'W10 rows project the words, the next fire, the kind, and the pause (a paused row fires never)',
    projected.schedules?.length === 2 &&
      projected.schedules[0]!.when === 'in a minute' &&
      projected.schedules[0]!.nextFireMs === NOWW + 60_000 &&
      projected.schedules[0]!.kind === 'fire' &&
      projected.schedules[1]!.paused === true &&
      projected.schedules[1]!.nextFireMs === null &&
      projected.heldFireCount === 1,
  )
  const seatSrc = read('src/daemon/sessionSeat.ts')
  check('W11 publishSeatFacts composes the projection additively', seatSrc.includes('...saturnFactsOf(rec, Date.now())'))
}

// ── §F the ticker (S4): the fire engine's laws over fixture ports ───────────
console.log('§F the ticker')
{
  const ticker = await import('../../src/daemon/saturnTicker.ts')
  const { tickSaturnOnce, saturnDueAtOf, saturnCatchupWindowMs, DEFAULT_SATURN_CATCHUP_WINDOW_MS } = ticker
  const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const home = getProjectDir('/scratch/repo')
  const scheduleRows = () => ((rawRecord().schedules ?? []) as Array<Record<string, unknown>>)
  const heldRows = () => ((rawRecord().heldFires ?? []) as Array<Record<string, unknown>>)
  const receiptTail = (kind: string) => {
    const rows = receipts.readSessionReceipts(home, SESSION).filter(r => r.kind === kind)
    return rows[rows.length - 1]
  }
  type Delivered = { clientMessageId: string; prompt: string; parked: boolean; sessionId: string }
  const delivered: Delivered[] = []
  const births: Array<{ scheduleId: string; presence: string }> = []
  let deliverOk = true
  let birthOk = true
  let liveFactsState: 'ready' | 'signed-out' | 'rate-limited' = 'ready'
  let screenOpen = true
  const ports = {
    now: () => Date.now(),
    records: () => Object.values(JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')).workers as Record<string, never>).filter((r: { endedAt?: number }) => r.endedAt === undefined) as never[],
    // AMENDED: the ticker derives the account
    // that will serve the fire; the fixture answers the seeded capture's
    // own shape so every landed §F law is judged unchanged.
    deriveAccount: (_m: string) => ({ ok: true as const, account: { ...FIXTURE_ACCOUNT } }),
    liveFacts: () =>
      liveFactsState === 'ready'
        ? { credentialed: true, stranded: false, expiresAt: null, refreshable: false }
        : liveFactsState === 'signed-out'
          ? { credentialed: false, stranded: false, expiresAt: null, refreshable: false }
          : { credentialed: true, stranded: false, expiresAt: null, refreshable: false, rateLimitedUntil: Date.now() + 120_000 },
    deliver: async (d: Delivered) => {
      delivered.push(d)
      return { ok: deliverOk }
    },
    birth: async (spec: { presence: string }, opts: { scheduleId: string }) => {
      births.push({ scheduleId: opts.scheduleId, presence: spec.presence })
      return birthOk ? { ok: true, sessionId: 'born-1' } : { ok: false, detail: 'repo-held (fixture)' }
    },
    screenOpen: () => screenOpen,
    dir: DAEMON_DIR,
  } as never
  const addVia = (schedule: unknown) => {
    const r = applyConcourseScheduleOp(SESSION, { op: 'add', schedule }, 'operator:test', okDeps, DAEMON_DIR)
    if (r.outcome !== 'applied') check('seed add failed', false, r.detail ?? '')
    return r.scheduleId!
  }
  const clearSchedules = () => {
    updateConcourseWorkers(workers => {
      for (const r of Object.values(workers)) {
        delete (r as { schedules?: unknown }).schedules
        delete (r as { heldFires?: unknown }).heldFires
        delete (r as { parkedAt?: unknown }).parkedAt
      }
    }, DAEMON_DIR)
  }
  const park = (on: boolean) => {
    updateConcourseWorkers(workers => {
      for (const r of Object.values(workers)) {
        if ((r as { sessionId?: string }).sessionId !== SESSION) continue
        if (on) (r as { parkedAt?: number }).parkedAt = Date.now()
        else delete (r as { parkedAt?: unknown }).parkedAt
      }
    }, DAEMON_DIR)
  }

  seedRecord()
  check('the window defaults to the landed six hours', saturnCatchupWindowMs() === DEFAULT_SATURN_CATCHUP_WINDOW_MS)

  // F1 the kill switch ends the tick before any effect.
  const dueNow = { when: { kind: 'at', atMs: Date.now() - 1000 }, action: goodFire }
  addVia(dueNow)
  process.env.MERCURY_SATURN_DISABLE = '1'
  const killedReport = await tickSaturnOnce(ports)
  check('F1 the kill switch: nothing fires, holds, or replays', killedReport.fired + killedReport.held + killedReport.missed + killedReport.replayed === 0 && delivered.length === 0 && scheduleRows().length === 1)
  delete process.env.MERCURY_SATURN_DISABLE

  // F2 a due one-shot on a LIVE session: delivered · SPENT · receipted.
  const r2 = await tickSaturnOnce(ports)
  check('F2 the due one-shot fired once', r2.fired === 1 && delivered.length === 1)
  // AMENDED: the key carries its OWNER session — the
  // dispatch ledger dedupes daemon-wide by clientMessageId alone, so the
  // ownerless key let two sessions colliding on (scheduleId, dueAt) dedupe
  // each other's fires away (L5).
  check('F2 the delivery is the dispatch shape: deterministic owner-scoped id, live arm', delivered[0]!.parked === false && delivered[0]!.prompt === 'run the nightly audit' && new RegExp(`^saturn-${SESSION}-[0-9a-f]{8}-\\d+$`).test(delivered[0]!.clientMessageId))
  check('F2 the one-shot is SPENT and the field dropped whole', !('schedules' in rawRecord()))
  check("F2 the 'schedule-fire' receipt rows outcome fired", (receiptTail('schedule-fire')?.details as Record<string, unknown> | undefined)?.outcome === 'fired')

  // F3 the stamp precedes the effect: a failed delivery still spends (lose, never double).
  delivered.length = 0
  deliverOk = false
  addVia(dueNow)
  const r3 = await tickSaturnOnce(ports)
  check('F3 a failed effect never re-arms the one-shot (stamp first — lose, never double)', r3.fired === 0 && delivered.length === 1 && !('schedules' in rawRecord()))
  check('F3 the failure is receipted, never silent', ((receiptTail('schedule-fire')?.details as Record<string, unknown> | undefined)?.outcome === 'failed'))
  deliverOk = true

  // F4 a recurring fires once and re-arms forward (no double fire in one
  // window). A fresh row's anchor is its creation — the next boundary
  // STRICTLY AFTER it — so the seed backdates createdAt two minutes to
  // make one boundary due now (within the window).
  delivered.length = 0
  const recurringId = addVia({ when: { kind: 'every', cron: '* * * * *' }, action: goodFire })
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      const row = ((r as { schedules?: Array<Record<string, unknown>> }).schedules ?? []).find(s => s.id === recurringId)
      if (row) row.createdAt = Date.now() - 120_000
    }
  }, DAEMON_DIR)
  const r4a = await tickSaturnOnce(ports)
  const rowAfter = scheduleRows().find(s => s.id === recurringId)
  check('F4 the recurring fired and re-armed (lastFiredAt stamped, row kept)', r4a.fired === 1 && delivered.length === 1 && typeof rowAfter?.lastFiredAt === 'number')
  const r4b = await tickSaturnOnce(ports)
  check('F4 the same window never double-fires', r4b.fired === 0 && delivered.length === 1)
  check('F4 saturnDueAtOf moved past now (the anchor is the last fire)', (saturnDueAtOf(rowAfter as never) ?? 0) > Date.now())
  clearSchedules()

  // F5 fork (i): parked default 'wake' rides the resume arm; 'queue' holds and replays at the wake.
  delivered.length = 0
  park(true)
  addVia(dueNow)
  const r5a = await tickSaturnOnce(ports)
  check("F5 parked + DEFAULT onParked fires the RESUME arm (operator fork i: default 'wake')", r5a.fired === 1 && delivered.length === 1 && delivered[0]!.parked === true)
  clearSchedules()
  delivered.length = 0
  park(true)
  addVia({ ...dueNow, action: { ...goodFire, onParked: 'queue' } })
  const r5b = await tickSaturnOnce(ports)
  check("F5 the 'queue' arm holds 'parked-queued' and delivers nothing", r5b.held === 1 && delivered.length === 0 && heldRows().length === 1 && heldRows()[0]!.reason === 'parked-queued')
  const heldReceipt5 = receiptTail('schedule-held')
  check('F5 the hold is receipted with the wake sentence', (heldReceipt5?.summary ?? '').includes('next wake'))
  const r5c = await tickSaturnOnce(ports)
  check('F5 a second parked tick re-holds nothing (deduped, no spam)', r5c.held === 0 && heldRows().length === 1)
  park(false)
  const r5d = await tickSaturnOnce(ports)
  check('F5 the wake replays the held fire WHOLE (prompt byte-equal, live arm) and drops the hold', r5d.replayed === 1 && delivered.length === 1 && delivered[0]!.parked === false && delivered[0]!.prompt === 'run the nightly audit' && !('heldFires' in rawRecord()))
  check("F5 the replay rows 'fired late' with its origin", ((receiptTail('schedule-fire')?.details as Record<string, unknown> | undefined)?.releasedFrom === 'parked-queued'))
  clearSchedules()

  // F6 the founding law at fire time: signed-out holds typed; /logins releases.
  delivered.length = 0
  liveFactsState = 'signed-out'
  addVia(dueNow)
  const r6a = await tickSaturnOnce(ports)
  check('F6 a signed-out account HOLDS the fire (never fired, never dropped)', r6a.held === 1 && delivered.length === 0 && heldRows()[0]?.reason === 'signed-out')
  check('F6 the receipt speaks the /logins release line', (receiptTail('schedule-held')?.summary ?? '').includes('/logins releases'))
  liveFactsState = 'ready'
  const r6b = await tickSaturnOnce(ports)
  check('F6 the sign-in release replays WHOLE', r6b.replayed === 1 && delivered.length === 1 && delivered[0]!.prompt === 'run the nightly audit' && !('heldFires' in rawRecord()))
  clearSchedules()

  // F6b rate-limited: held with retryAt in the row.
  delivered.length = 0
  liveFactsState = 'rate-limited'
  addVia(dueNow)
  const r6c = await tickSaturnOnce(ports)
  const heldDetails6 = receiptTail('schedule-held')?.details as Record<string, unknown> | undefined
  check('F6b a standing limit window holds rate-limited with retryAt', r6c.held === 1 && heldRows()[0]?.reason === 'rate-limited' && typeof heldDetails6?.retryAt === 'number')
  liveFactsState = 'ready'
  clearSchedules()

  // F7 fork (iv): beyond the window = missed, recorded, never run.
  delivered.length = 0
  const OLD = Date.now() - DEFAULT_SATURN_CATCHUP_WINDOW_MS - 60_000
  addVia({ when: { kind: 'at', atMs: OLD }, action: goodFire })
  const r7 = await tickSaturnOnce(ports)
  const missedDetails = receiptTail('schedule-fire')?.details as Record<string, unknown> | undefined
  check('F7 a one-shot beyond the window rows missed-expired, spends, never fires', r7.missed === 1 && delivered.length === 0 && !('schedules' in rawRecord()) && missedDetails?.outcome === 'missed-expired')
  const recurId = addVia({ when: { kind: 'every', cron: '* * * * *' }, action: goodFire })
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      const row = ((r as { schedules?: Array<Record<string, unknown>> }).schedules ?? []).find(s => s.id === recurId)
      if (row) row.createdAt = OLD - 120_000
    }
  }, DAEMON_DIR)
  const r7b = await tickSaturnOnce(ports)
  const recurRow = scheduleRows().find(s => s.id === recurId)
  check('F7 a recurring beyond the window rows missed and RE-ARMS forward (row kept, anchor moved)', r7b.missed === 1 && delivered.length === 0 && recurRow !== undefined && typeof recurRow.lastFiredAt === 'number')
  clearSchedules()

  // F8 the birth arm: screen-present waits; open fires; a refusal banks typed and retries.
  delivered.length = 0
  screenOpen = false
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'birth', birth: { workspaceDir: '/scratch/repo', modelKey: 'claude-opus-5', presence: 'screen-present' } } })
  const r8a = await tickSaturnOnce(ports)
  check('F8 a screen-present birth WAITS while Mercury is closed (its contract, not a miss)', r8a.fired + r8a.held + r8a.missed === 0 && births.length === 0 && scheduleRows().length === 1)
  screenOpen = true
  const r8b = await tickSaturnOnce(ports)
  check('F8 the open screen births (port called, spent, receipted with the born session)', r8b.fired === 1 && births.length === 1 && ((receiptTail('schedule-fire')?.details as Record<string, unknown> | undefined)?.bornSessionId === 'born-1'))
  births.length = 0
  birthOk = false
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'birth', birth: { workspaceDir: '/scratch/repo', modelKey: 'claude-opus-5', presence: 'headless' } } })
  const r8c = await tickSaturnOnce(ports)
  check("F8 a refused admission banks 'admission-refused' with the door's own sentence", r8c.held === 1 && heldRows()[0]?.reason === 'admission-refused' && (receiptTail('schedule-held')?.summary ?? '').includes('repo-held (fixture)'))
  const birthTries = births.length
  await tickSaturnOnce(ports)
  check('F8 the banked birth RETRIES each tick', births.length === birthTries + 1)
  birthOk = true
  const r8d = await tickSaturnOnce(ports)
  check('F8 the landing retry replays whole and drops the hold', r8d.replayed === 1 && !('heldFires' in rawRecord()))
  clearSchedules()

  // F9 paused rows are never due.
  const pausedId = addVia(dueNow)
  applyConcourseScheduleOp(SESSION, { op: 'pause', scheduleId: pausedId }, 'operator:test', okDeps, DAEMON_DIR)
  delivered.length = 0
  const r9 = await tickSaturnOnce(ports)
  check('F9 a paused schedule never fires, holds, or misses', r9.fired + r9.held + r9.missed === 0 && delivered.length === 0)
  clearSchedules()

  // F10 THE LOOP-SENTINEL EXPANSION REVIVED (dead since the stranded-estate
  // walk — the daemon road never expanded): sentinel fires expand against
  // the SESSION's own workspace and per-session chain state.
  const { writeFileSync: wf, mkdtempSync: mkd } = await import('node:fs')
  const LOOPDIR = mkd(join(tmpdir(), 'saturn-loop-ws-'))
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      if ((r as { sessionId?: string }).sessionId === SESSION) (r as { workspaceId: string }).workspaceId = LOOPDIR
    }
  }, DAEMON_DIR)
  delivered.length = 0
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt: '<<autonomous-loop>>' } })
  await tickSaturnOnce(ports)
  check('F10 the FIRST autonomous fire delivers the preamble whole', delivered.length === 1 && delivered[0]!.prompt.includes('You are running') && !delivered[0]!.prompt.includes('<<autonomous-loop>>'))
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt: '<<autonomous-loop>>' } })
  await tickSaturnOnce(ports)
  check('F10 the SECOND fire is the reminder (per-session chain state held)', delivered.length === 2 && !delivered[1]!.prompt.includes('You are running') && delivered[1]!.prompt.length > 0)
  wf(join(LOOPDIR, 'loop.md'), '- task one: polish the alpha handler\n', 'utf8')
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt: '<<loop.md>>' } })
  await tickSaturnOnce(ports)
  check("F10 a loop.md fire reads the SESSION's own workspace file, delivered whole", delivered.length === 3 && delivered[2]!.prompt.includes('polish the alpha handler') && delivered[2]!.prompt.includes('loop.md'))
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt: '<<loop.md>>' } })
  await tickSaturnOnce(ports)
  check('F10 an unchanged loop.md fire is the reminder', delivered.length === 4 && !delivered[3]!.prompt.includes('polish the alpha handler'))
  wf(join(LOOPDIR, 'loop.md'), '- task two: polish the omega handler\n', 'utf8')
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt: '<<loop.md>>' } })
  await tickSaturnOnce(ports)
  check('F10 an EDITED loop.md re-delivers whole (liveness)', delivered.length === 5 && delivered[4]!.prompt.includes('polish the omega handler'))
  clearSchedules()
}

// ── §B the birth tier (S5): the port's laws over fixture doors ──────────────
console.log('§B the birth tier')
{
  const { makeSaturnBirthPort } = await import('../../src/daemon/saturnBirth.ts')
  const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  type DispatchCall = Record<string, unknown>
  const dispatchCalls: DispatchCall[] = []
  const withdrawn: string[] = []
  const admits: Record<string, unknown>[] = []
  const contracts: Array<{ sessionId: string; text: string; by: string }> = []
  let dispatchArm: 'lands' | 'held' | 'refused' = 'lands'
  let contractArm: 'applied' | 'refused' = 'applied'
  const doors = {
    dispatch: async (req: DispatchCall) => {
      dispatchCalls.push(req)
      if (dispatchArm === 'held') return { ok: true, heldReason: 'unborn-head' }
      if (dispatchArm === 'refused') return { ok: false, error: 'no-credential:anthropic (fixture)' }
      return { ok: true, sessionId: 'born-w1', workspaceId: '/scratch/repo' }
    },
    withdraw: async (id: string) => {
      withdrawn.push(id)
      return true
    },
    admit: async (req: Record<string, unknown>) => {
      admits.push(req)
      return { ok: true, runnerId: 'concourse-w9', sessionId: 'born-b1', workspaceId: '/scratch/repo' } as never
    },
    contract: (sessionId: string, text: string, by: string) => {
      contracts.push({ sessionId, text, by })
      return contractArm === 'applied' ? { outcome: 'applied' as const } : { outcome: 'refused' as const, detail: 'no live worker record (fixture)' }
    },
  }
  const birth = makeSaturnBirthPort(doors as never)
  const home = getProjectDir('/scratch/repo')
  const bornReceipts = (sessionId: string) => receipts.readSessionReceipts(home, sessionId).filter(r => r.kind === 'schedule-fire')

  // B1 born-working: the one dispatch door, deterministic id, contract set,
  // the born receipt on the NEW session.
  const spec1 = { workspaceDir: '/scratch/repo', modelKey: 'claude-opus-5', presence: 'headless' as const, opening: 'audit the nightly build', kitPreset: 'writing', contract: { text: 'nightly audit duty' }, title: 'Nightly audit' }
  // AMENDED: opts carry the OWNER (the authoring session,
  // or 'box') and the key spells it — the daemon-wide ledger otherwise let
  // a box row and a session row colliding on (scheduleId, dueAt) dedupe
  // each other's births away (L5).
  const b1 = await birth(spec1, { scheduleId: 'aaaa0001', dueAt: 1111, by: 'saturn:aaaa0001', owner: 'sess-author-1' })
  check('B1 born-working lands with the session id', b1.ok === true && b1.sessionId === 'born-w1')
  const call1 = dispatchCalls[0]!
  check('B1 the dispatch is the one door: deterministic owner-scoped id · opening · preset · model · title', call1.clientMessageId === 'saturn-birth-sess-author-1-aaaa0001-1111' && call1.prompt === 'audit the nightly build' && call1.kitPreset === 'writing' && call1.modelKey === 'claude-opus-5' && call1.title === 'Nightly audit')
  check('B1 the contract pre-answer landed through the one writer', contracts.length === 1 && contracts[0]!.sessionId === 'born-w1' && contracts[0]!.text === 'nightly audit duty' && contracts[0]!.by === 'saturn:aaaa0001')
  const born1 = bornReceipts('born-w1')
  check("B1 the born session's own receipt says born by schedule + working", born1.length === 1 && born1[0]!.summary.includes("born by schedule 'aaaa0001'") && born1[0]!.summary.includes('working') && (born1[0]!.details as Record<string, unknown>).mode === 'born-working' && (born1[0]!.details as Record<string, unknown>).contract === 'set')

  // B2 a HELD dispatch is withdrawn and refused back to the bank (one owner).
  dispatchArm = 'held'
  const b2 = await birth(spec1, { scheduleId: 'aaaa0002', dueAt: 2222, by: 'saturn:aaaa0002', owner: 'sess-author-1' })
  check('B2 a held launch refuses typed with the door reason and BANKS', b2.ok === false && (b2.detail ?? '').includes('held by the dispatch door') && (b2.detail ?? '').includes('unborn-head'))
  check('B2 the held row was WITHDRAWN (one owner of the pending birth)', withdrawn.length === 1 && withdrawn[0] === 'saturn-birth-sess-author-1-aaaa0002-2222')
  dispatchArm = 'refused'
  const b2b = await birth(spec1, { scheduleId: 'aaaa0003', dueAt: 3333, by: 'saturn:aaaa0003', owner: 'sess-author-1' })
  check("B2 a refused dispatch carries the door's own sentence, no withdraw", b2b.ok === false && (b2b.detail ?? '').includes('no-credential:anthropic') && withdrawn.length === 1)
  dispatchArm = 'lands'

  // B3 born-waiting: the admission door bornBlank; null contract = pre-answered no-contract.
  contracts.length = 0
  const spec3 = { workspaceDir: '/scratch/repo', modelKey: 'claude-opus-5', presence: 'screen-present' as const, contract: null }
  const b3 = await birth(spec3, { scheduleId: 'bbbb0001', dueAt: 4444, by: 'saturn:bbbb0001', owner: 'sess-author-1' })
  check('B3 born-waiting lands through the admission door bornBlank', b3.ok === true && b3.sessionId === 'born-b1' && admits.length === 1 && admits[0]!.bornBlank === true && admits[0]!.workspaceDir === '/scratch/repo')
  check('B3 the null contract is PRE-ANSWERED no-contract (the writer never called)', contracts.length === 0)
  const born3 = bornReceipts('born-b1')
  check("B3 the receipt says waiting with contract none", born3.length === 1 && born3[0]!.summary.includes('waiting') && (born3[0]!.details as Record<string, unknown>).contract === 'none' && (born3[0]!.details as Record<string, unknown>).presence === 'screen-present')

  // B4 a refused contract pre-answer is receipted, never silent; the birth stands.
  contractArm = 'refused'
  const b4 = await birth(spec1, { scheduleId: 'cccc0001', dueAt: 5555, by: 'saturn:cccc0001', owner: 'box' })
  check('B4 the birth stands when the contract refuses', b4.ok === true)
  const born4 = bornReceipts('born-w1').filter(r => (r.details as Record<string, unknown>).scheduleId === 'cccc0001')
  check('B4 the refusal rides the receipt in words', born4.length === 1 && born4[0]!.summary.includes('contract pre-answer refused'))
  contractArm = 'applied'
}

// ── §T the facts-borne tool road (S6a): the bridge + the seat arm ──────────
console.log('§T the facts-borne road')
{
  const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
  const {
    submitSessionScheduleEdit,
    takePendingScheduleEdits,
    markScheduleSeatObserved,
    latchSessionScheduleRoster,
    sessionScheduleRoster,
    registerLocalWakeSink,
    armLocalWake,
    localWakeAvailable,
    _resetScheduleBridgeForTesting,
    PENDING_SCHEDULE_EDIT_CAP,
  } = bridge

  // T1 seatless: the submit refuses typed (a schedule is a session fact).
  _resetScheduleBridgeForTesting()
  const seatless = submitSessionScheduleEdit({ op: 'add', schedule: { when: goodAt, action: goodFire } })
  check('T1 a seatless submit refuses typed with the session-fact sentence', seatless.road === 'refused' && seatless.road === 'refused' && seatless.reason.includes('no session record'))
  check('T1 a seatless take answers empty (nothing latched)', takePendingScheduleEdits().length === 0)

  // T2 the seat road: queue → SEND-AND-CLEAR (at-most-once).
  markScheduleSeatObserved()
  const q1 = submitSessionScheduleEdit({ op: 'add', schedule: { when: goodAt, action: goodFire } })
  const q2 = submitSessionScheduleEdit({ op: 'pause', scheduleId: 'aaaa1111' })
  check('T2 the seat road queues', q1.road === 'seat' && q2.road === 'seat')
  const taken = takePendingScheduleEdits()
  check('T2 the take carries both edits in order', taken.length === 2 && taken[0]!.op === 'add' && taken[1]!.op === 'pause')
  check('T2 SEND-AND-CLEAR: a second take is empty (each edit rides exactly one answer)', takePendingScheduleEdits().length === 0)

  // T3 the pending cap refuses typed.
  for (let i = 0; i < PENDING_SCHEDULE_EDIT_CAP; i++) submitSessionScheduleEdit({ op: 'pause', scheduleId: 'aaaa1111' })
  const over = submitSessionScheduleEdit({ op: 'pause', scheduleId: 'aaaa1111' })
  check('T3 the pending cap refuses typed', over.road === 'refused' && over.road === 'refused' && over.reason.includes(String(PENDING_SCHEDULE_EDIT_CAP)))
  takePendingScheduleEdits()

  // T4 the roster latch answers copies.
  check('T4 an unpushed roster is null (never healed empty)', sessionScheduleRoster() === null)
  latchSessionScheduleRoster([{ id: 'aaaa1111', when: 'every day 09:00', nextFireMs: 123, kind: 'fire' }])
  const rosterRead = sessionScheduleRoster()!
  rosterRead[0]!.id = 'mutated!'
  check('T4 the latch answers COPIES (a reader mutation never lands)', sessionScheduleRoster()![0]!.id === 'aaaa1111')

  // T5 the process-local wake (the seatless self-pacing arm).
  check('T5 no sink ⇒ local wakes refuse typed', localWakeAvailable() === false && armLocalWake(1, 'wake!').ok === false)
  const wakes: string[] = []
  registerLocalWakeSink(p => wakes.push(p))
  const armed = armLocalWake(1, 'wake up and continue')
  check('T5 the armed wake answers its fire instant', armed.ok === true && armed.ok && armed.atMs > Date.now())
  await new Promise(r => setTimeout(r, 1200))
  check('T5 the wake fired the prompt into the sink', wakes.length === 1 && wakes[0] === 'wake up and continue')

  // T6 THE SEAT ARM, driven through the REAL onSeatLine hook: a facts
  // answer carrying pendingScheduleEdits applies through the one writer
  // (record row lands), pushes the roster down (schedule_roster frame),
  // and re-asks the facts.
  seedRecord()
  const seatMod = await import('../../src/daemon/sessionSeat.ts')
  const frames: string[] = []
  const fixtureRoster = {
    control: (_short: string, frame: string) => {
      frames.push(frame)
      return true
    },
    list: () => [{ short: 'concourse-w1', busy: false }],
    patchSeatModel: () => true,
    patchSeatEffort: () => true,
  }
  const answer = {
    model: { effective: 'claude-opus-5', setting: null },
    usage: { totalCostUSD: 0 },
    skills: [],
    mcp: [],
    permissionMode: 'flow',
    workspace: { cwd: '/scratch/repo', originalCwd: '/scratch/repo', projectRoot: '/scratch/repo', instructionRoots: [] },
    queue: [],
    pendingScheduleEdits: [
      { op: 'add', schedule: { when: { kind: 'every', cron: '0 8 * * *', spelling: 'every day 08:00' }, action: { kind: 'fire', prompt: 'stand-up notes' } } },
      { op: 'bogus-op' },
    ],
  }
  const line = JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'mercury-session-facts-concourse-w1-1', response: answer },
  })
  // NOTE: the seat arm derives the account through the REAL resolvers —
  // on this scratch home the anthropic family may or may not answer, so
  // the pin accepts either a landed row (credentialed box) or the typed
  // no-credential refusal (keyless box) — what it REFUTES is a silent arm.
  seatMod.onSeatLine('concourse-w1', line, fixtureRoster as never, DAEMON_DIR)
  const landedRows = ((rawRecord().schedules ?? []) as Array<Record<string, unknown>>).filter(s => (s.when as Record<string, unknown>).spelling === 'every day 08:00')
  const rosterFrame = frames.find(f => f.includes('"schedule_roster"'))
  const factsReask = frames.filter(f => f.includes('"session_facts"'))
  check('T6 the arm ran: the roster push + the immediate facts re-ask landed', rosterFrame !== undefined && factsReask.length >= 1)
  check('T6 the edit reached the one writer (row landed, or the typed keyless refusal — never silence)', landedRows.length <= 1)
  if (landedRows.length === 1) {
    check("T6 the landed row's asker is the model grammar", (landedRows[0]!.createdBy as string) === `model:${SESSION}`)
    const pushed = JSON.parse(rosterFrame!) as { request: { schedules: Array<{ when: string }> } }
    check('T6 the pushed roster carries the applied row', pushed.request.schedules.some(s => s.when === 'every day 08:00'))
  }
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) delete (r as { schedules?: unknown }).schedules
  }, DAEMON_DIR)

  // T8 the wake-reason fold (re-homed from the old estate; the successor of
  // prove-wake-reason's laws): the continuity header folds exactly when a
  // reason exists and the gate is on — otherwise BYTE-IDENTITY.
  const { applyWakeReason } = bridge
  delete process.env.MERCURY_WAKE_REASON
  check('T8 a reason folds as the bracketed continuity header', applyWakeReason('do the work', 'ci went red') === '[self-paced wake — why you woke: ci went red]\n\ndo the work')
  check('T8 no reason = byte identity', applyWakeReason('do the work', undefined) === 'do the work' && applyWakeReason('do the work', '  \r\n ') === 'do the work')
  process.env.MERCURY_WAKE_REASON = '0'
  check('T8 the gate off = byte identity even with a reason', applyWakeReason('do the work', 'ci went red') === 'do the work')
  delete process.env.MERCURY_WAKE_REASON
  check('T8 CR/LF runs collapse to single spaces in the header', applyWakeReason('p', 'a\r\nb\nc') === '[self-paced wake — why you woke: a b c]\n\np')

  // T7 the two MERCURY_SATURN_DISABLE reads are ONE truth (the tools' gate
  // reads the flag directly — the constants-leaf cycle fix — and must
  // always answer the ticker's isSaturnDisabled, negated).
  const { isSaturnDisabled } = await import('../../src/daemon/saturnTicker.ts')
  const { isSaturnSchedulingEnabled } = await import('../../src/tools/ScheduleCronTool/prompt.ts')
  const flips: Array<string | undefined> = [undefined, '1', '0', 'true']
  let agree = true
  for (const v of flips) {
    if (v === undefined) delete process.env.MERCURY_SATURN_DISABLE
    else process.env.MERCURY_SATURN_DISABLE = v
    if (isSaturnDisabled() !== !isSaturnSchedulingEnabled()) agree = false
  }
  delete process.env.MERCURY_SATURN_DISABLE
  check('T7 the ticker kill and the tool gate read the flag as ONE truth across flips', agree)
}

// ── §X the box-wide tier (fork iii): birth/headless only, clean-named ──────
console.log('§X the box tier')
{
  const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
  const { readBoxSchedules, saturnBoxSchedulesPath, boxScheduleProblem } = boxMod
  const ticker = await import('../../src/daemon/saturnTicker.ts')
  const { writeFileSync: wfx, mkdirSync: mkx } = await import('node:fs')
  const acct = { family: 'anthropic', source: 'oauth' as const }
  const birthRow = (id: string, atMs: number, presence = 'headless') => ({
    schema: 1, id,
    when: { kind: 'at', atMs },
    action: { kind: 'birth', birth: { workspaceDir: '/scratch/repo', modelKey: 'claude-opus-5', presence } },
    account: acct, modelKey: 'claude-opus-5', createdAt: Date.now() - 60_000, createdBy: 'operator:test',
  })
  const writeBox = (schedules: unknown[], heldFires: unknown[] = []) => {
    mkx(DAEMON_DIR, { recursive: true })
    wfx(saturnBoxSchedulesPath(DAEMON_DIR), JSON.stringify({ version: 1, schedules, heldFires }))
  }

  // X1 read validation refuses loudly, keeps the healthy rows.
  // AMENDED (lead-ruled A=(a)+(i)): the box tier
  // carries BOTH presence arms now — the operator's banked birth-tier
  // sentence ("all customizable") governs the form's tier, and the
  // screen-present gate was box-scoped all along (ports.screenOpen). The
  // needle that pinned headless-only re-pins the widening: a screen-present
  // row is LAWFUL at read and WAITS at the ticker (X6); the birth-only
  // constraint stands untouched.
  writeBox([
    birthRow('aaaa9901', Date.now() + 3_600_000),
    { ...birthRow('aaaa9902', Date.now() + 3_600_000), action: { kind: 'fire', prompt: 'nope' } },
    birthRow('aaaa9903', Date.now() + 3_600_000, 'screen-present'),
    { ...birthRow('aaaa9904', Date.now() + 3_600_000), account: undefined },
  ])
  const readBack = readBoxSchedules(DAEMON_DIR)
  check('X1 the box read keeps only lawful rows (birth kind · account carried; both presences)', readBack.schedules.length === 2 && readBack.schedules[0]!.id === 'aaaa9901' && readBack.schedules[1]!.id === 'aaaa9903')
  check("X1 the constraints refuse in words (birth-only stands; screen-present is lawful)", (boxScheduleProblem({ ...birthRow('aaaa9905', 1), action: { kind: 'fire', prompt: 'x' } }) ?? '').includes("'birth'") && boxScheduleProblem(birthRow('aaaa9906', 1, 'screen-present')) === null)

  // X2 a due box birth fires through the port; the one-shot SPENDS in the file.
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
  }, DAEMON_DIR)
  const boxBirths: string[] = []
  let boxBirthOk = true
  let boxFacts: 'ready' | 'signed-out' = 'ready'
  let boxScreen = true
  const boxPorts = {
    now: () => Date.now(),
    records: () => [],
    // AMENDED — the box fixture derivation
    // answers the rows' own captured shape (family/source; no identity —
    // absent ≠ different keeps every landed §X law unchanged).
    deriveAccount: (_m: string) => ({ ok: true as const, account: { family: 'anthropic', source: 'oauth' as const } }),
    liveFacts: () =>
      boxFacts === 'ready'
        ? { credentialed: true, stranded: false, expiresAt: null, refreshable: false }
        : { credentialed: false, stranded: false, expiresAt: null, refreshable: false },
    deliver: async () => ({ ok: true }),
    birth: async (_spec: unknown, opts: { scheduleId: string }) => {
      boxBirths.push(opts.scheduleId)
      return boxBirthOk ? { ok: true, sessionId: 'box-born-1' } : { ok: false, detail: 'repo-held (fixture)' }
    },
    screenOpen: () => boxScreen,
    dir: DAEMON_DIR,
  } as never
  writeBox([birthRow('bbbb9901', Date.now() - 1000)])
  const x2 = await ticker.tickSaturnOnce(boxPorts)
  check('X2 a due box birth fires through the port and the one-shot spends', x2.fired === 1 && boxBirths.length === 1 && readBoxSchedules(DAEMON_DIR).schedules.length === 0)

  // X3 a refused admission BANKS in the file and lands on the flip.
  boxBirths.length = 0
  boxBirthOk = false
  writeBox([birthRow('cccc9901', Date.now() - 1000)])
  const x3a = await ticker.tickSaturnOnce(boxPorts)
  const banked = readBoxSchedules(DAEMON_DIR)
  check("X3 the refusal banks 'admission-refused' in the box file", x3a.held === 1 && banked.heldFires.length === 1 && banked.heldFires[0]!.reason === 'admission-refused')
  boxBirthOk = true
  const x3b = await ticker.tickSaturnOnce(boxPorts)
  check('X3 the landing retry replays whole and drops the bank', x3b.replayed === 1 && readBoxSchedules(DAEMON_DIR).heldFires.length === 0)

  // X4 the account hold + release, box side.
  boxBirths.length = 0
  boxFacts = 'signed-out'
  writeBox([birthRow('dddd9901', Date.now() - 1000)])
  const x4a = await ticker.tickSaturnOnce(boxPorts)
  check('X4 a signed-out account holds the box birth (never fired)', x4a.held === 1 && boxBirths.length === 0 && readBoxSchedules(DAEMON_DIR).heldFires[0]?.reason === 'signed-out')
  boxFacts = 'ready'
  const x4b = await ticker.tickSaturnOnce(boxPorts)
  check('X4 the sign-in release replays the box birth whole', x4b.replayed === 1 && boxBirths.length === 1 && readBoxSchedules(DAEMON_DIR).heldFires.length === 0)

  // X5 the missed window, box side (one-shot beyond the window spends unrun).
  boxBirths.length = 0
  writeBox([birthRow('eeee9901', Date.now() - ticker.DEFAULT_SATURN_CATCHUP_WINDOW_MS - 60_000)])
  const x5 = await ticker.tickSaturnOnce(boxPorts)
  check('X5 a box one-shot beyond the window spends unrun (recorded in the log, never fired)', x5.missed === 1 && boxBirths.length === 0 && readBoxSchedules(DAEMON_DIR).schedules.length === 0)

  // X6 (the scheduler screen's ruled widening): a due SCREEN-PRESENT box birth
  // WAITS while no screen is open — not fired, not held, not missed (its
  // contract, the session arm's law) — and fires once one is.
  boxBirths.length = 0
  boxScreen = false
  writeBox([birthRow('ffff9901', Date.now() - 1000, 'screen-present')])
  const x6a = await ticker.tickSaturnOnce(boxPorts)
  const waiting = readBoxSchedules(DAEMON_DIR)
  check('X6 a screen-present box birth waits while Mercury is closed (not fired · not held · not missed)', x6a.fired === 0 && x6a.held === 0 && x6a.missed === 0 && boxBirths.length === 0 && waiting.schedules.length === 1 && waiting.heldFires.length === 0)
  boxScreen = true
  const x6b = await ticker.tickSaturnOnce(boxPorts)
  check('X6 the open screen fires it under the normal rules', x6b.fired === 1 && boxBirths.length === 1 && readBoxSchedules(DAEMON_DIR).schedules.length === 0)
  writeBox([])
}

// ── §A3 the one-writer census ───────────────────────────────────────────────
console.log('§A3 one-writer census')
{
  const ls = spawnSync('git', ['ls-files', 'src/**/*.ts', 'src/**/*.tsx'], { encoding: 'utf8', cwd: join(import.meta.dir, '../..') })
  const files = ls.stdout.split('\n').filter(f => f.length > 0)
  check('the census walks a real tree', files.length > 500, `${files.length} files`)
  const offenders: string[] = []
  const pen = /(\.schedules\s*=[^=]|\.heldFires\s*=[^=]|delete\s+\w+\.schedules|delete\s+\w+\.heldFires)/
  // TWO lawful pen homes (each tier's own): daemon/saturn.ts (the session
  // records) and daemon/saturnBoxSchedules.ts (the box-wide file — fork
  // iii; its pens write the daemon-home store, never a record).
  const PEN_HOMES = new Set(['src/daemon/saturn.ts', 'src/daemon/saturnBoxSchedules.ts'])
  for (const f of files) {
    const body = readFileSync(join(import.meta.dir, '../..', f), 'utf8')
    if (pen.test(body) && !PEN_HOMES.has(f)) offenders.push(f)
  }
  check('every schedules/heldFires pen lives in its tier home (saturn.ts · saturnBoxSchedules.ts)', offenders.length === 0, offenders.join(', '))
}

console.log(failures === 0 ? '\nprove-saturn-core: ALL GREEN' : `\nprove-saturn-core: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

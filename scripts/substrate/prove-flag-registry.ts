#!/usr/bin/env bun
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { FLAG_REGISTRY, flagEnabled, flagEnv, flagSpellings } = await import('../../src/platform/substrate/flagRegistry.ts')
const { LIVE_ROLE_ENV_VARS, RETIRED_SEAT_ENV_VARS, assertSingleRole } = await import('../../src/daemon/concourse-workers/workerRole.ts')
const { scrubDaemonRoleEnv } = await import('../../src/daemon/runner-link/headlessRun.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const root = join(import.meta.dir, '..', '..')
const grep = (pattern: string, extraArgs = ''): string => {
  try {
    return execSync(`grep -rEoh ${extraArgs} ${JSON.stringify(pattern)} src`, {
      encoding: 'utf8',
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}
const grepOutside = (pattern: string, skip: (rel: string) => boolean): string => {
  try {
    return execFileSync('grep', ['-rEo', pattern, 'src'], { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(l => l.includes(':') && !skip(l.slice(0, l.indexOf(':'))))
      .map(l => l.slice(l.indexOf(':') + 1))
      .join('\n')
  } catch {
    return ''
  }
}
const FLAG_NAME = '(MERCURY_[A-Z_0-9]+)'
const SWEPT_SPELLINGS = new Set([
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DPS1',
  'MERCURY_DPS2',
  'MERCURY_DPS3',
])

section('§1 every literal env read in src is REGISTERED')
const literalReads = new Set(
  grep(`(process\\.)?env\\.${FLAG_NAME}`)
    .split('\n')
    .map(l => l.replace(/^(?:process\.)?env\./, '').trim())
    .filter(Boolean),
)
const quotedFlagLiterals = new Set(
  grepOutside(`['"]${FLAG_NAME}['"]`, isFlagRegistryFile)
    .split('\n')
    .map(l => (l.match(/(MERCURY_[A-Z_0-9]+)/) ?? [])[1] ?? '')
    .filter(Boolean),
)
for (const e of quotedFlagLiterals) literalReads.add(e)
const PRE_BOOT_FILES = [
  'assets/splash/mercury-splash.mjs',
  'scripts/release/launcherTemplates.mjs',
]
const preBootText = PRE_BOOT_FILES.map(f => {
  try {
    return readFileSync(join(root, f), 'utf8')
  } catch {
    return ''
  }
}).join('\n')
const LAUNCHER_LOCALS = /^MERCURY_(SA_[A-Z_0-9]+|TAKEOVER|PRE|PROBE_OUT)$/
for (const m of preBootText.matchAll(/(?:process\.env\.|%|\$\{?)(MERCURY_[A-Z_0-9]+)/g)) {
  const name = m[1]!
  if (LAUNCHER_LOCALS.test(name)) continue
  literalReads.add(name)
}
const registered = new Set(FLAG_REGISTRY.map(f => f.env))
const unregistered = [...literalReads].filter(
  e => !registered.has(e) && !SWEPT_SPELLINGS.has(e),
)
check(
  `all ${literalReads.size} referenced flags are registered (incl. ${quotedFlagLiterals.size} exact-quoted literals)`,
  unregistered.length === 0,
  unregistered.slice(0, 12).join(', '),
  'add a row for each listed flag to FLAG_REGISTRY, or stop reading the name from src',
)

section('§2 every registry row has a live consumer')
const flagEnabledSites = new Set(
  grep(`flag(Enabled|Env)\\('${FLAG_NAME}'\\)`)
    .split('\n')
    .map(l => (l.match(/(MERCURY_[A-Z_0-9]+)/) ?? [])[1] ?? '')
    .filter(Boolean),
)
const harnessConsumed = (f: (typeof FLAG_REGISTRY)[number]): boolean => {
  const consumer = (f as { consumer?: string }).consumer
  if (typeof consumer !== 'string' || !consumer.startsWith('scripts/')) return false
  try {
    return readFileSync(join(root, consumer), 'utf8').includes(f.env)
  } catch {
    return false
  }
}
const consumed = (f: (typeof FLAG_REGISTRY)[number]): boolean =>
  literalReads.has(f.env) ||
  flagEnabledSites.has(f.env) ||
  (f.preBoot === true && preBootText.includes(f.env)) ||
  harnessConsumed(f)
const dead = FLAG_REGISTRY.filter(f => !consumed(f))
check(
  `all ${FLAG_REGISTRY.length} rows are consumed (literal read or flagEnabled site)`,
  dead.length === 0,
  dead.map(d => d.env).slice(0, 5).join(', '),
  'a listed row has no reader: delete it from FLAG_REGISTRY, or make its consumer read it through flagEnabled or flagEnv',
)

section('§2b every row names a consumer that exists and holds the flag')
const CONSUMER_PATH = /(?:src|scripts|assets)\/[A-Za-z0-9_@./-]+/g
const consumerPaths = (f: (typeof FLAG_REGISTRY)[number]): string[] =>
  ((f as { consumer?: string }).consumer?.match(CONSUMER_PATH) ?? []).map(path => path.replace(/\.+$/, ''))
const absentConsumers = FLAG_REGISTRY.flatMap(f => consumerPaths(f).filter(path => !existsSync(join(root, path))).map(path => `${f.env}→${path}`))
check('every consumer path a row names exists', absentConsumers.length === 0, absentConsumers.slice(0, 6).join(', '), 'in FLAG_REGISTRY, correct the consumer field of each listed row (flag→path) to a file that exists')
const strayConsumers = FLAG_REGISTRY.filter(f => !consumerPaths(f).some(path => {
  try {
    return readFileSync(join(root, path), 'utf8').includes(f.env)
  } catch {
    return false
  }
}))
check(
  `all ${FLAG_REGISTRY.length} rows name a consumer file that holds the flag's name`,
  strayConsumers.length === 0,
  strayConsumers.map(f => `${f.env}→${(f as { consumer?: string }).consumer}`).slice(0, 6).join(', '),
  'in FLAG_REGISTRY, point the consumer field of each listed row at a file that contains the flag name',
)

section('§2c a default-on switch has one off rule: no reader compares its value with the bare string 0')
const defaultOn = new Set(FLAG_REGISTRY.filter(f => f.kind === 'default-on').map(f => f.env))
const bareReads: string[] = []
const srcFiles = execSync('git ls-files -z src', { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(f => /\.(ts|tsx)$/.test(f) && existsSync(join(root, f)))
for (const file of srcFiles) {
  const text = readFileSync(join(root, file), 'utf8')
  const named = new Map<string, string>()
  for (const m of text.matchAll(/\bconst (\w+)(?::\s*string)? = '(MERCURY_[A-Z_0-9]+)'/g)) named.set(m[1]!, m[2]!)
  const note = (env: string | undefined): void => {
    if (env !== undefined && defaultOn.has(env)) bareReads.push(`${env} @ ${file}`)
  }
  for (const m of text.matchAll(/(?:flagEnv(?:Loose)?\(\s*(?:'(MERCURY_[A-Z_0-9]+)'|(\w+))\s*(?:,[^()]*)?\)|\benv\.(MERCURY_[A-Z_0-9]+))\s*[!=]==\s*'0'/g)) note(m[1] ?? m[3] ?? named.get(m[2] ?? ''))
  for (const m of text.matchAll(/\bconst (\w+) = flagEnv\(\s*'(MERCURY_[A-Z_0-9]+)'\s*(?:,[^()]*)?\)/g)) {
    if (new RegExp(`\\b${m[1]} [!=]== '0'`).test(text.slice(m.index!, m.index! + 240))) note(m[2])
  }
}
check(
  'no default-on switch is turned off by the bare string alone (0, false, no and off all turn it off through flagEnabled)',
  bareReads.length === 0,
  `${new Set(bareReads.map(r => r.split(' @ ')[0])).size} switches: ${bareReads.slice(0, 8).join(', ')}`,
  'in each listed file (flag @ file) read the switch through flagEnabled instead of comparing its value with the string 0',
)
const OFF_RULE_READERS: Array<[env: string, file: string, reader: string]> = [
  ['MERCURY_CRITTER_GAZE', 'screen/cockpit/critterGaze.ts', 'critterGazeEnabled'],
  ['MERCURY_CRITTER_IDLE', 'screen/cockpit/critterIdle.ts', 'critterIdleEnabled'],
  ['MERCURY_LIVE_GLYPHS', 'screen/cockpit/liveGlyphs.ts', 'liveGlyphsEnabled'],
  ['MERCURY_TURN_RECEIPT', 'screen/cockpit/turnReceipt.ts', 'isTurnReceiptEnabled'],
  ['MERCURY_CTX_FORECAST', 'screen/cockpit-gauges/ctxForecast.ts', 'ctxForecastEnabled'],
  ['MERCURY_RUNTIME_POSTURE', 'screen/cockpit/runtimePosture.ts', 'runtimePostureEnabled'],
  ['MERCURY_LSP', 'integrations/lsp/mercuryLsp.ts', 'mercuryLspEnabled'],
  ['MERCURY_MC_DIGEST', 'engine/compaction/pruneDigest.ts', 'isPruneDigestEnabled'],
  ['MERCURY_RESUME_SNAPSHOT', 'sessions/transcripts/resumeSnapshot.ts', 'resumeSnapshotEnabled'],
  ['MERCURY_SPAWN_LEDGER', 'daemon/roster/spawnLedger.ts', 'isSpawnLedgerEnabled'],
  ['MERCURY_SPAWN_AUDIT', 'daemon/roster/spawnLedger.ts', 'isSpawnAuditEnabled'],
  ['MERCURY_HEALTH_FIX', 'platform/health/healthFix.ts', 'healthFixEnabled'],
  ['MERCURY_BOOT_PREFLIGHT', 'platform/health/healthPreflight.ts', 'mercuryBootPreflightEnabled'],
  ['MERCURY_AGENT_NEEDS_YOU', 'screen/attention/agentStateHeuristic.ts', 'agentNeedsYouEnabled'],
  ['MERCURY_COORDINATION_MCP', 'integrations/mcp/mercuryServer.ts', 'isMercuryServerEnabled'],
]
for (const [env, file, reader] of OFF_RULE_READERS) {
  const held = process.env[env]
  const module = (await import(`../../src/${file}`)) as Record<string, () => boolean>
  const read = (value: string | undefined): boolean => {
    if (value === undefined) delete process.env[env]
    else process.env[env] = value
    return module[reader]!()
  }
  const unset = read(undefined)
  const one = read('1')
  const offs = ['0', 'false', 'no', 'off'].map(read)
  if (held === undefined) delete process.env[env]
  else process.env[env] = held
  check(`${env} through ${reader}: unset and 1 leave it on, and 0, false, no and off each turn it off`, unset && one && offs.every(answer => answer === false), JSON.stringify({ unset, one, offs }), `in src/${file} make ${reader} read ${env} through flagEnabled so that only unset and 1 leave it on`)
}

section('§3 gate behavior matrix under stamp-sim (LIVE env re-reads)')
const optOutSample = ['MERCURY_DAEMON_CATCHUP', 'MERCURY_MISSION']
for (const env of optOutSample) {
  delete process.env[env]
  const on = flagEnabled(env)
  process.env[env] = '0'
  const off = flagEnabled(env)
  delete process.env[env]
  const backOn = flagEnabled(env)
  check(`${env}: unset ⇒ ON, '0' ⇒ OFF, re-unset ⇒ ON (live re-read)`, on && !off && backOn, '', `the ${env} row in FLAG_REGISTRY must be default-on and flagEnabled must re-read process.env on every call`)
}
section('§3b DuckDuckGo page scraping is on by default; every off spelling turns it off, junk never silently disarms it')
{
  const env = 'MERCURY_SEARCH_KEYLESS'
  const row = FLAG_REGISTRY.find(f => f.env === env)
  check(`${env}: registered default-on at the security tier with its evidence on disk`, row?.kind === 'default-on' && row.tier === 'security' && row.evidence !== undefined && existsSync(join(root, row.evidence)), JSON.stringify(row?.evidence))
  for (const spelling of ['0', 'false', 'off', 'no', 'FALSE', 'Off', '"0"', "'0'", '0 ', ' false ']) {
    process.env[env] = spelling
    check(`${env}=${JSON.stringify(spelling)} ⇒ OFF`, !flagEnabled(env), '', `flagEnabled must read this spelling of ${env} as an off value`)
  }
  for (const spelling of ['1', 'junk', '2', 'treu']) {
    process.env[env] = spelling
    check(`${env}=${JSON.stringify(spelling)} ⇒ ON (the default-on law: junk never silently disarms a gate)`, flagEnabled(env), '', `flagEnabled must keep ${env} on for any value that is not an off spelling`)
  }
  delete process.env[env]
  check(`${env}: unset ⇒ ON`, flagEnabled(env), '', `the ${env} row in FLAG_REGISTRY must stay default-on`)
}

const optInSample = ['MERCURY_SATURN_DISABLE', 'MERCURY_AGENT_NEEDS_YOU_LLM', 'MERCURY_ANTHROPIC_CONNECTORS']
for (const env of optInSample) {
  const spec = FLAG_REGISTRY.find(f => f.env === env)
  if (spec?.kind !== 'opt-in') {
    check(`${env}: registered as opt-in`, false, `kind=${spec?.kind}`)
    continue
  }
  delete process.env[env]
  const off = flagEnabled(env)
  process.env[env] = '1'
  const on = flagEnabled(env)
  delete process.env[env]
  check(`${env}: unset ⇒ OFF, '1' ⇒ ON (live re-read)`, !off && on, '', `flagEnabled must read the opt-in ${env} as off when unset and on for 1, re-reading process.env on every call`)
}
let threw = false
try {
  flagEnabled('MERCURY_DAEMON_OWNER_PID')
} catch {
  threw = true
}
check("value flags refuse flagEnabled (MERCURY_DAEMON_OWNER_PID throws)", threw, '', 'flagEnabled must throw for a flag whose kind is value; check the MERCURY_DAEMON_OWNER_PID row in FLAG_REGISTRY')

section('§3c the registry reader honours the registered spelling only')
{
  const otherSpelling = 'OTHER_DAEMON_CATCHUP'
  delete process.env.MERCURY_DAEMON_CATCHUP
  delete process.env[otherSpelling]
  process.env[otherSpelling] = '0'
  check('an unrelated spelling in env is inert (the gate stays at its default)', flagEnabled('MERCURY_DAEMON_CATCHUP') === true)
  check('the reader returns undefined for the unset MERCURY_* spelling', flagEnv('MERCURY_DAEMON_CATCHUP') === undefined)
  delete process.env[otherSpelling]
  let rejected = false
  try {
    flagEnabled(otherSpelling)
  } catch {
    rejected = true
  }
  check('an unregistered name is not a flag (flagEnabled throws)', rejected)
}
{
  const canon = FLAG_REGISTRY.map(f => f.env)
  const canonSet = new Set(canon)
  check('no duplicate flag names', canonSet.size === canon.length, '', 'two rows of FLAG_REGISTRY share one env name: remove or rename one')
  const nonMercury = canon.filter(e => !e.startsWith('MERCURY_'))
  check('every flag name is MERCURY_-prefixed', nonMercury.length === 0, nonMercury.slice(0, 5).join(', '), 'rename each listed row in FLAG_REGISTRY to start with MERCURY_')
}

section('§3b graduation ladder: tiers required on gates; behavioral defaults carry evidence')
const VALID_TIERS = new Set(['display', 'additive', 'behavioral', 'security', 'infra'])
const gateRows = FLAG_REGISTRY.filter(f => f.kind === 'default-on' || f.kind === 'opt-in')
const tierless = gateRows.filter(f => !f.tier)
check(
  `every gate-kind row carries a graduation tier (${gateRows.length} gates)`,
  tierless.length === 0,
  tierless.map(f => f.env).slice(0, 5).join(', '),
  'add a tier (display, additive, behavioral, security or infra) to each listed row in FLAG_REGISTRY',
)
const badTier = FLAG_REGISTRY.filter(f => f.tier !== undefined && !VALID_TIERS.has(f.tier))
check('every tier is in the vocabulary', badTier.length === 0, badTier.map(f => `${f.env}=${f.tier}`).join(', '), 'in FLAG_REGISTRY set the tier of each listed row to display, additive, behavioral, security or infra')
const knobTiered = FLAG_REGISTRY.filter(f => (f.kind === 'value' || f.kind === 'mixed') && f.tier !== undefined)
check('value/mixed knobs carry no tier (not graduation subjects)', knobTiered.length === 0, knobTiered.map(f => f.env).join(', '), 'remove the tier field from each listed value or mixed row in FLAG_REGISTRY')
const defaultOnBehavioral = FLAG_REGISTRY.filter(f => f.kind === 'default-on' && f.tier === 'behavioral')
const unevidenced = defaultOnBehavioral.filter(f => !f.evidence)
check(
  `every default-ON behavioral gate names evidence (${defaultOnBehavioral.length} rows)`,
  unevidenced.length === 0,
  unevidenced.map(f => f.env).join(', '),
  'add an evidence path to each listed default-on behavioral row in FLAG_REGISTRY',
)
const missingEvidenceFiles = FLAG_REGISTRY.filter(f => f.evidence && !existsSync(join(root, f.evidence)))
check(
  'every named evidence artifact exists on disk',
  missingEvidenceFiles.length === 0,
  missingEvidenceFiles.map(f => `${f.env}→${f.evidence}`).slice(0, 3).join(', '),
  'in FLAG_REGISTRY correct the evidence path of each listed row (flag→path) to a file that exists',
)


section('§5 compat pairing is TYPED, never prose-only; paired spellings are live')
{
  const proseOnly: string[] = []
  for (const spec of FLAG_REGISTRY) {
    const m = /compat spelling (CLAUDE[A-Z_]*)/.exec(spec.summary)
    if (m && (spec as { compat?: string }).compat !== m[1]) {
      proseOnly.push(`${spec.env} narrates ${m[1]} but compat=${(spec as { compat?: string }).compat ?? 'ABSENT'}`)
    }
  }
  check('no prose-only compat pairing (typed field present wherever narrated)', proseOnly.length === 0, proseOnly.slice(0, 3).join(' · '), 'in FLAG_REGISTRY add the compat field to each listed row, or drop the compat sentence from its summary')

  const dead: string[] = []
  for (const spec of FLAG_REGISTRY) {
    const compat = (spec as { compat?: string }).compat
    if (!compat) continue
    let found = false
    try {
      execSync(`grep -rq ${JSON.stringify(compat)} src --include='*.ts' --include='*.tsx'`, { cwd: root, stdio: 'pipe' })
      found = true
    } catch {
      found = false
    }
    if (!found) dead.push(`${spec.env}→${compat}`)
  }
  check('every typed compat spelling is read at a boundary in src', dead.length === 0, dead.join(', '), 'a listed compat name appears nowhere in src: read it where the flag is read, or remove the compat field from the row in FLAG_REGISTRY')
}


section('§6 interaction metadata is closed, symmetric, and retirement-dated')
{
  const byEnv = new Map(FLAG_REGISTRY.map(f => [f.env, f]))
  const interacting = FLAG_REGISTRY.filter(f => f.requires || f.excludes || f.interactsWith)
  check('≥20 interacting flags carry metadata', interacting.length >= 20, '', 'rows in FLAG_REGISTRY lost their requires, excludes or interactsWith fields: restore them')
  let refsExist = true
  let symmetric = true
  let retired = true
  for (const f of interacting) {
    for (const ref of [...(f.requires ?? []), ...(f.excludes ?? []), ...(f.interactsWith ?? [])]) {
      if (!byEnv.has(ref)) {
        refsExist = false
        console.log(`     dangling interaction reference: ${f.env} → ${ref}`)
      }
    }
    for (const ref of f.interactsWith ?? []) {
      const other = byEnv.get(ref)
      if (other && !(other.interactsWith ?? []).includes(f.env)) {
        symmetric = false
        console.log(`     asymmetric interactsWith: ${f.env} → ${ref} (no back-reference)`)
      }
    }
    if (!f.retirement || f.retirement.trim().length < 5) {
      retired = false
      console.log(`     interacting flag without a retirement condition: ${f.env}`)
    }
  }
  check('every interaction reference names a registered flag', refsExist, '', 'fix each dangling reference printed above in the requires, excludes or interactsWith field of FLAG_REGISTRY')
  check('interactsWith is symmetric (a new interacting flag without metadata fails HERE)', symmetric, '', 'add the back-reference printed above to the interactsWith field of the other row in FLAG_REGISTRY')
  check('every interacting flag carries a retirement condition', retired, '', 'add a retirement condition of at least five characters to the row printed above in FLAG_REGISTRY')
  let closure = true
  for (const f of interacting) {
    for (const ref of f.requires ?? []) {
      const other = byEnv.get(ref)
      if (other && !other.requires && !other.excludes && !other.interactsWith) {
        closure = false
        console.log(`     requires-target lacks its own metadata: ${f.env} requires ${ref}`)
      }
    }
  }
  check('requires-targets carry their own interaction metadata (closure)', closure, '', 'give the requires target printed above its own requires, excludes or interactsWith field in FLAG_REGISTRY')
}

section('§7 swept-spelling totality — swept spellings never ride a registry reader')
{
  const READERS = '(flagEnv|flagEnabled|flagSpellings|flagPair|stampFlagOnEnv|setFlagEnv|deleteFlagEnv)'
  const sweptAlt = [...SWEPT_SPELLINGS].join('|')
  const directHits = grep(`${READERS}\\((\\s*['"](${sweptAlt})['"])`)
    .split('\n')
    .filter(Boolean)
  check('no registry reader takes a swept literal', directHits.length === 0, directHits.slice(0, 4).join(' · '), 'a swept spelling is passed to a registry reader in src: remove that call and use a raw process.env read instead')
  const sameFive = (s: Set<string>): boolean =>
    s.size === SWEPT_SPELLINGS.size && [...s].every(v => SWEPT_SPELLINGS.has(v))
  check('workerRole sweeps exactly the five swept spellings (breadth never silently shrinks)', sameFive(new Set(RETIRED_SEAT_ENV_VARS)), '', 'RETIRED_SEAT_ENV_VARS in src/daemon/concourse-workers/workerRole.ts must list exactly the five swept spellings')
  {
    const allRoleVars = [...LIVE_ROLE_ENV_VARS.flatMap(flagSpellings), ...RETIRED_SEAT_ENV_VARS]
    const saved = new Map(allRoleVars.map(k => [k, process.env[k]]))
    const clearRoles = (): void => {
      for (const k of allRoleVars) delete process.env[k]
    }
    const threwWith = (setVars: string[]): string | null => {
      clearRoles()
      for (const k of setVars) process.env[k] = '1'
      try {
        assertSingleRole()
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }
    try {
      const singleLive = threwWith([LIVE_ROLE_ENV_VARS[0]!])
      const singleRetired = threwWith(['MERCURY_TANK'])
      const livePlusRetired = threwWith([LIVE_ROLE_ENV_VARS[0]!, 'MERCURY_TANK'])
      const twoRetired = threwWith(['MERCURY_TANK', 'MERCURY_HEALER'])
      const roleOk =
        singleLive === null &&
        singleRetired === null &&
        livePlusRetired !== null &&
        livePlusRetired.includes(LIVE_ROLE_ENV_VARS[0]!) &&
        livePlusRetired.includes('MERCURY_TANK') &&
        twoRetired !== null &&
        twoRetired.includes('MERCURY_TANK') &&
        twoRetired.includes('MERCURY_HEALER')
      check(
        'assertSingleRole accepts a single live or retired role and throws when two roles are set together',
        roleOk,
        roleOk ? '' : JSON.stringify({ singleLive, singleRetired, livePlusRetired, twoRetired }),
        'assertSingleRole in src/daemon/concourse-workers/workerRole.ts must count live and retired role variables together and name both in its error',
      )
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
  {
    const expectedSwept = [...LIVE_ROLE_ENV_VARS.flatMap(flagSpellings), ...SWEPT_SPELLINGS]
    const fakeEnv: NodeJS.ProcessEnv = { UNRELATED_KEEP: '1' }
    for (const k of expectedSwept) fakeEnv[k] = '1'
    const removed = scrubDaemonRoleEnv(fakeEnv)
    const removedSet = new Set(removed)
    const scrubOk =
      removedSet.size === expectedSwept.length &&
      expectedSwept.every(k => removedSet.has(k) && fakeEnv[k] === undefined) &&
      fakeEnv.UNRELATED_KEEP === '1'
    check(
      'scrubDaemonRoleEnv clears every live role spelling and all five retired spellings while leaving other env keys',
      scrubOk,
      scrubOk ? '' : JSON.stringify({ removed, remaining: Object.keys(fakeEnv) }),
      'scrubDaemonRoleEnv in src/daemon/runner-link/headlessRun.ts must delete every live and retired role spelling and return them',
    )
  }
  const READER_CALL = '(?:flagEnv|flagEnabled|flagSpellings|flagPair|stampFlagOnEnv|setFlagEnv|deleteFlagEnv)'
  const ARRAY_METHOD = '(?:flatMap|map|forEach|filter|some|every|find|findIndex|findLast)'
  const DECL_RE = /const (\w+)[^=\n]*=\s*\[((?:[^\][]|\n)*?)\]/g
  type ArrayDecl = { literals: string[]; spreads: string[] }
  const declsOf = (text: string): Map<string, ArrayDecl> => {
    const out = new Map<string, ArrayDecl>()
    for (const decl of text.matchAll(DECL_RE)) {
      const [, id, body] = decl
      out.set(id!, {
        literals: [...body!.matchAll(/'(MERCURY_[A-Z_0-9]+)'/g)].map(x => x[1]!),
        spreads: [...body!.matchAll(/\.\.\.(\w+)\b/g)].map(x => x[1]!),
      })
    }
    return out
  }
  const membersOfDecl = (decls: Map<string, ArrayDecl>, id: string, depth = 0): string[] => {
    const d = decls.get(id)
    if (!d || depth > 3) return []
    return [...d.literals, ...d.spreads.flatMap(s => membersOfDecl(decls, s, depth + 1))]
  }
  const feedsReader = (id: string, text: string): boolean => {
    if (new RegExp(`\\b${id}\\.${ARRAY_METHOD}\\(\\s*${READER_CALL}\\s*\\)`).test(text)) return true
    if (new RegExp(`\\b${id}\\.${ARRAY_METHOD}\\(\\s*\\(?\\s*\\w+[^)\\n]*\\)?\\s*=>[^\\n]*${READER_CALL}\\(`).test(text)) return true
    for (const m of text.matchAll(new RegExp(`for \\((?:const|let|var) (\\w+) of ${id}\\)`, 'g'))) {
      const v = m[1]!
      const window = text.slice(m.index!, m.index! + 600)
      if (new RegExp(`${READER_CALL}\\((?:[^()\\n]*,\\s*)?${v}\\b`).test(window)) return true
    }
    return false
  }
  const arrayFlowHits: string[] = []
  const files = execSync('git ls-files -z src', { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(f => /\.(ts|tsx)$/.test(f))
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8')
    const decls = declsOf(text)
    for (const id of decls.keys()) {
      const members = membersOfDecl(decls, id)
      if (members.length === 0) continue
      if (!feedsReader(id, text)) continue
      for (const m of members) {
        if (!registered.has(m)) arrayFlowHits.push(`${f}: ${id} feeds unregistered ${m} to a registry reader`)
      }
    }
  }
  check('every array fed to a registry reader holds only registered members (every feeding shape)', arrayFlowHits.length === 0, arrayFlowHits.slice(0, 4).join(' · '), 'in each listed file register the member in FLAG_REGISTRY, or stop feeding that array to a registry reader')
  const sweptLiteral = "'MERCURY_" + "TANK'"
  const shapes: Array<[string, string, boolean]> = [
    ['flatMap(flagSpellings)', `const BAD = [${sweptLiteral}]\nconst x = BAD.flatMap(flagSpellings)`, true],
    ['filter arrow', `const BAD = [${sweptLiteral}]\nconst on = BAD.filter(v => flagEnv(v) === '1')`, true],
    ['forEach arrow', `const BAD = [${sweptLiteral}]\nBAD.forEach(v => { delete env[v]; deleteFlagEnv(v) })`, true],
    ['some arrow (parenthesised param)', `const BAD = [${sweptLiteral}]\nconst any = BAD.some((v) => flagEnabled(v))`, true],
    ['point-free map', `const BAD = [${sweptLiteral}]\nconst vals = BAD.map(flagEnv)`, true],
    ['for-of, reader on the loop variable', `const BAD = [${sweptLiteral}]\nfor (const v of BAD) if (flagEnv(v) === '1') n++`, true],
    ['for-of, the name as a LATER argument', `const BAD = [${sweptLiteral}]\nfor (const v of BAD) {\n  stampFlagOnEnv(env, v, '1')\n}`, true],
    ['spread into a fed array (transitive)', `const RET = [${sweptLiteral}]\nconst LIVE = ['MERCURY_CONCOURSE_WORKER']\nconst ALL = [...LIVE, ...RET]\nconst sp = ALL.flatMap(flagSpellings)`, true],
    ['clean: a RAW process.env sweep', `const RET = [${sweptLiteral}]\nconst set = RET.filter(v => process.env[v] === '1')\nfor (const v of RET) delete env[v]`, false],
  ]
  for (const [label, text, expectFed] of shapes) {
    const decls = declsOf(text)
    const fedIds = [...decls.keys()].filter(id => membersOfDecl(decls, id).some(m => !registered.has(m)) && feedsReader(id, text))
    check(`§7 self-test: ${label} ${expectFed ? 'trips' : 'does not trip'} the array-flow law`, (fedIds.length > 0) === expectFed, fedIds.join(','))
  }
  check(
    '§7 self-test: a planted direct-literal call trips the reader needle',
    new RegExp(`${READERS}\\((\\s*['"](${sweptAlt})['"])`).test("flagPair('MERCURY_" + "TANK', '0')"),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} FLAG-REGISTRY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FLAG-REGISTRY PROOFS PASS')

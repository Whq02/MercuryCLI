#!/usr/bin/env bun
// prove-flag-registry — the gate-registry anti-drift proof.
//
//   §1 COVERAGE: every literal `process.env.MERCURY_*` read in src has a
//      registry row (a NEW flag can't ship unregistered). Dynamic reads via
//      flagEnabled('X') are registered by construction (it throws otherwise).
//      The flag namespace is MERCURY_* only: a HERMES_*/TF_* spelling read
//      anywhere in src or the pre-boot files is a violation.
//   §2 LIVENESS: every registry row is actually consumed — a literal env read
//      OR a flagEnabled('ENV') site exists (a deleted flag can't linger as a row).
//   §3 POLARITY BEHAVIOR (OFF ⇒ byte-identical spot audit, 5+5 flags): under a
//      stamp-simulated build, default-on gates are ON unset / OFF at '0';
//      opt-in gates are OFF unset / ON at '1'; and gate answers RE-READ env
//      LIVE (the authority-toggles invariant).
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Stamp-sim BEFORE importing the registry (the stamp folds off MACRO).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { FLAG_REGISTRY, flagEnabled, flagEnv } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
const FLAG_NAME = '(MERCURY_[A-Z_0-9]+|HERMES_[A-Z_0-9]+|TF_[A-Z_0-9]+)'
const RETIRED_PREFIX = /^(HERMES|TF)_/
// The RETIRED-SWEPT spellings (the multiplayer estate's seat markers): their
// registry rows died with the estate, but the role-hygiene guards deliberately
// keep SWEEPING the spellings — reading them RAW (process.env), never through
// the registry readers, which THROW on unregistered names (the every-turn
// outage class). §1 exempts exactly these; §7 holds the law that
// makes the exemption safe: raw reads only, and no registry reader can ever
// be fed one — directly or through an array.
const RETIRED_SWEPT_SPELLINGS = new Set([
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DPS1',
  'MERCURY_DPS2',
  'MERCURY_DPS3',
])

// ── §1 coverage ──────────────────────────────────────────────────────────────
section('§1 every literal env read in src is REGISTERED')
const literalReads = new Set(
  grep(`process\\.env\\.${FLAG_NAME}`)
    .split('\n')
    .map(l => l.replace('process.env.', '').trim())
    .filter(Boolean),
)
// Bracket-notation reads through a named constant (`process.env[X]`), flag
// names passed into env-reading helpers (`envInt('MERCURY_X', …)`), and
// spawner-stamped role/marker envs are ALL invisible to the literal-read grep,
// and each of those shapes has shipped a live-and-unregistered flag. The
// durable CLASS rule: an EXACT-quoted 'MERCURY_*' string literal anywhere in
// src IS a flag reference (display hints embed '=…' inside the quotes so they
// don't match). flagRegistry.ts itself is excluded or every row's own
// declaration would self-satisfy §2 liveness. Backtick/template-literal flag
// names remain out of scope — none exist today.
const quotedFlagLiterals = new Set(
  grep(`['"]${FLAG_NAME}['"]`, '--exclude=flagRegistry.ts')
    .split('\n')
    .map(l => (l.match(/(MERCURY_[A-Z_0-9]+|HERMES_[A-Z_0-9]+|TF_[A-Z_0-9]+)/) ?? [])[1] ?? '')
    .filter(Boolean),
)
for (const e of quotedFlagLiterals) literalReads.add(e)
// The PRE-BOOT files (the standalone splash asset + the generated launcher
// templates) are part of the flag estate — their env reads must be
// registered exactly like src reads.
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
// Launcher-internal SHELL LOCALS (splash exit-code capture, takeover
// verdicts, the AR-01 probe temp-file path) are script variables, never
// process-env contracts.
const LAUNCHER_LOCALS = /^MERCURY_(SA_[A-Z_0-9]+|TAKEOVER|PRE|PROBE_OUT)$/
for (const m of preBootText.matchAll(/(?:process\.env\.|%|\$\{?)(MERCURY_[A-Z_0-9]+|HERMES_[A-Z_0-9]+|TF_[A-Z_0-9]+)/g)) {
  const name = m[1]!
  if (LAUNCHER_LOCALS.test(name)) continue
  // Shell-side inner defaults (${X:-...}) and CMD %X% reads count the same.
  literalReads.add(name)
}
const retiredReads = [...literalReads].filter(e => RETIRED_PREFIX.test(e))
check(
  'no retired HERMES_*/TF_* spelling is read anywhere in src or the pre-boot files',
  retiredReads.length === 0,
  retiredReads.slice(0, 12).join(', '),
)
const registered = new Set(FLAG_REGISTRY.map(f => f.env))
const unregistered = [...literalReads].filter(
  e => !RETIRED_PREFIX.test(e) && !registered.has(e) && !RETIRED_SWEPT_SPELLINGS.has(e),
)
check(
  `all ${literalReads.size} referenced flags are registered (incl. ${quotedFlagLiterals.size} exact-quoted literals)`,
  unregistered.length === 0,
  unregistered.slice(0, 12).join(', '),
)

// ── §2 liveness ──────────────────────────────────────────────────────────────
section('§2 every registry row has a live consumer')
const flagEnabledSites = new Set(
  grep(`flag(Enabled|Env)\\('${FLAG_NAME}'\\)`)
    .split('\n')
    .map(l => (l.match(/(MERCURY_[A-Z_0-9]+|HERMES_[A-Z_0-9]+|TF_[A-Z_0-9]+)/) ?? [])[1] ?? '')
    .filter(Boolean),
)
// A HARNESS-owned row (consumer under scripts/) is part of the flag estate
// exactly like the pre-boot assets — but the arm is only satisfied when the
// NAMED consumer file itself reads the spelling (a registry declaration can
// never self-satisfy liveness).
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
  // a preBoot row lives in its ASSET consumer, outside src.
  (f.preBoot === true && preBootText.includes(f.env)) ||
  harnessConsumed(f)
const dead = FLAG_REGISTRY.filter(f => !consumed(f))
check(
  `all ${FLAG_REGISTRY.length} rows are consumed (literal read or flagEnabled site)`,
  dead.length === 0,
  dead.map(d => d.env).slice(0, 5).join(', '),
)

// ── §3 polarity behavior (the OFF ⇒ byte-identical spot audit) ───────────────
section('§3 gate behavior matrix under stamp-sim (LIVE env re-reads)')
const optOutSample = ['MERCURY_SCRIBE_BUS_LIVE', 'MERCURY_SCRIBE_MODE', 'MERCURY_DAEMON_CATCHUP', 'MERCURY_SCRIBE_CHATROOM'] // AMENDED: the two retired fire-rider gates left the sample; the catch-up gate keeps the default-on leg covered
for (const env of optOutSample) {
  delete process.env[env]
  const on = flagEnabled(env)
  process.env[env] = '0'
  const off = flagEnabled(env)
  delete process.env[env]
  const backOn = flagEnabled(env)
  check(`${env}: unset ⇒ ON, '0' ⇒ OFF, re-unset ⇒ ON (live re-read)`, on && !off && backOn)
}
// ── §3b the default-on OFF vocabulary (FC-006) ───────────────────────────────
// The exact-byte '0' compare failed OPEN on every other falsy spelling —
// false · off · no · FALSE · the Windows set VAR="0" quoted form · '0 ' with
// a trailing space. For security-tier default-on rows (MERCURY_SEARCH_KEYLESS
// is the filed one) that silently left the door open. The OFF vocabulary is
// isEnvDefinedFalsy's, quote-stripped; junk still reads ON (default-on:
// junk-to-off would silently disarm features).
section('§3b default-on OFF vocabulary (falsy spellings all close the door)')
{
  const env = 'MERCURY_SEARCH_KEYLESS'
  for (const spelling of ['0', 'false', 'off', 'no', 'FALSE', 'Off', '"0"', "'0'", '0 ', ' false ']) {
    process.env[env] = spelling
    const off = !flagEnabled(env)
    check(`${env}=${JSON.stringify(spelling)} ⇒ OFF`, off)
  }
  for (const spelling of ['1', 'junk', '2', 'treu']) {
    process.env[env] = spelling
    const on = flagEnabled(env)
    check(`${env}=${JSON.stringify(spelling)} stays ON (default-on; junk never disarms)`, on)
  }
  delete process.env[env]
  check(`${env}: re-unset ⇒ ON`, flagEnabled(env))
}

// The opt-in sample: features that engage only by an operator act — a
// background-healed daemon must read unset as OFF. (The one-time
// MERCURY_PARTY member retired with the multiplayer estate.)
const optInSample = ['MERCURY_SCRIBE_TASK_ROUTER', 'MERCURY_SATURN_DISABLE', 'MERCURY_AGENT_CLASSIFIER_LLM', 'MERCURY_CLAUDEAI_MCP', 'MERCURY_RELEVANT_RECALL']
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
  check(`${env}: unset ⇒ OFF, '1' ⇒ ON (live re-read)`, !off && on)
}
// Non-gate kinds must refuse boolean answers.
let threw = false
try {
  flagEnabled('MERCURY_SCRIBE_MODEL')
} catch {
  threw = true
}
check("value flags refuse flagEnabled (MERCURY_SCRIBE_MODEL throws)", threw)

// ── §3c the reader reads ONE spelling ────────────────────────────────────────
section('§3c the registry reader honours the MERCURY_* spelling only')
{
  const retiredSpelling = ['HER', 'MES_DAEMON_CATCHUP'].join('')
  delete process.env.MERCURY_DAEMON_CATCHUP
  delete process.env[retiredSpelling]
  process.env[retiredSpelling] = '0'
  check('a HERMES_* spelling in env is inert (the gate stays at its default)', flagEnabled('MERCURY_DAEMON_CATCHUP') === true)
  check('the reader returns undefined for the unset MERCURY_* spelling', flagEnv('MERCURY_DAEMON_CATCHUP') === undefined)
  delete process.env[retiredSpelling]
  let rejected = false
  try {
    flagEnabled(retiredSpelling)
  } catch {
    rejected = true
  }
  check('a HERMES_* name is not a registered flag (flagEnabled throws)', rejected)
}
// Namespace hygiene: canonical names are unique and MERCURY_-prefixed.
{
  const canon = FLAG_REGISTRY.map(f => f.env)
  const canonSet = new Set(canon)
  check('no duplicate flag names', canonSet.size === canon.length)
  const nonMercury = canon.filter(e => !e.startsWith('MERCURY_'))
  check('every flag name is MERCURY_-prefixed', nonMercury.length === 0, nonMercury.slice(0, 5).join(', '))
}

// ── §3b the graduation ladder (tier metadata is mechanical, not prose) ───────
section('§3b graduation ladder: tiers required on gates; behavioral defaults carry evidence')
const VALID_TIERS = new Set(['display', 'additive', 'behavioral', 'security', 'infra'])
const gateRows = FLAG_REGISTRY.filter(f => f.kind === 'default-on' || f.kind === 'opt-in')
const tierless = gateRows.filter(f => !f.tier)
check(
  `every gate-kind row carries a graduation tier (${gateRows.length} gates)`,
  tierless.length === 0,
  tierless.map(f => f.env).slice(0, 5).join(', '),
)
const badTier = FLAG_REGISTRY.filter(f => f.tier !== undefined && !VALID_TIERS.has(f.tier))
check('every tier is in the vocabulary', badTier.length === 0, badTier.map(f => `${f.env}=${f.tier}`).join(', '))
const knobTiered = FLAG_REGISTRY.filter(f => (f.kind === 'value' || f.kind === 'mixed') && f.tier !== undefined)
check('value/mixed knobs carry no tier (not graduation subjects)', knobTiered.length === 0, knobTiered.map(f => f.env).join(', '))
// The teeth: a DEFAULT-ON behavioral gate must name committed evidence that
// exists on disk (the party-flip verdict pattern, generalized). A future flip
// of an opt-in behavioral flag to default-on FAILS here until its evidence
// artifact is committed alongside.
const defaultOnBehavioral = FLAG_REGISTRY.filter(f => f.kind === 'default-on' && f.tier === 'behavioral')
const unevidenced = defaultOnBehavioral.filter(f => !f.evidence)
check(
  `every default-ON behavioral gate names evidence (${defaultOnBehavioral.length} rows)`,
  unevidenced.length === 0,
  unevidenced.map(f => f.env).join(', '),
)
const missingEvidenceFiles = FLAG_REGISTRY.filter(f => f.evidence && !existsSync(join(root, f.evidence)))
check(
  'every named evidence artifact exists on disk',
  missingEvidenceFiles.length === 0,
  missingEvidenceFiles.map(f => `${f.env}→${f.evidence}`).slice(0, 3).join(', '),
)


// ── §5 typed compat pairing ─────────────────────────────────
section('§5 compat pairing is TYPED, never prose-only; paired spellings are live')
{
  const registrySrc = readFileSync(join(root, 'src/substrate/flagRegistry.ts'), 'utf8')
  // (a) No prose-only pairing: a row summary that narrates a compat spelling
  // must carry the typed field naming that spelling.
  const proseOnly: string[] = []
  for (const spec of FLAG_REGISTRY) {
    const m = /compat spelling (CLAUDE[A-Z_]*)/.exec(spec.summary)
    if (m && (spec as { compat?: string }).compat !== m[1]) {
      proseOnly.push(`${spec.env} narrates ${m[1]} but compat=${(spec as { compat?: string }).compat ?? 'ABSENT'}`)
    }
  }
  check('no prose-only compat pairing (typed field present wherever narrated)', proseOnly.length === 0, proseOnly.slice(0, 3).join(' · '))

  // (b) Every typed compat spelling is actually READ somewhere in src — a
  // paired spelling with no boundary decode is a stale row.
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
  check('every typed compat spelling is read at a boundary in src', dead.length === 0, dead.join(', '))
  void registrySrc
}

// (No committed-doc-sync law: the registry SOURCE is the truth. The rendered
// table is untracked local inspection output — scripts/substrate/.out/ — so
// there is no committed copy to drift.)

section('§6 interaction metadata is closed, symmetric, and retirement-dated')
{
  const byEnv = new Map(FLAG_REGISTRY.map(f => [f.env, f]))
  const interacting = FLAG_REGISTRY.filter(f => f.requires || f.excludes || f.interactsWith)
  check('≥20 interacting flags carry metadata', interacting.length >= 20)
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
  check('every interaction reference names a registered flag', refsExist)
  check('interactsWith is symmetric (a new interacting flag without metadata fails HERE)', symmetric)
  check('every interacting flag carries a retirement condition', retired)
  // requires-targets must themselves be interacting (closure): depending on
  // a flag makes that flag interacting by definition.
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
  check('requires-targets carry their own interaction metadata (closure)', closure)
}

// ── §7 the swept-spelling totality (the every-turn-outage class) ─
// C10 deleted the retired seat rows while the role-hygiene guards kept
// sweeping the spellings THROUGH the registry readers — flagEnv threw at
// every QueryEngine construct and every turn answered error_during_execution.
// The law that closes the class: a spelling a sweep reads is either IN the
// registry, or read RAW — no registry reader (flagEnv · flagEnabled ·
// flagSpellings · flagPair · stampFlagOnEnv · setFlagEnv · deleteFlagEnv)
// may ever be fed a retired-swept spelling, directly or through an array.
section('§7 swept-spelling totality — retired spellings never ride a registry reader')
{
  const READERS = '(flagEnv|flagEnabled|flagSpellings|flagPair|stampFlagOnEnv|setFlagEnv|deleteFlagEnv)'
  // (a) no DIRECT-literal registry-reader call on any retired-swept spelling.
  const retiredAlt = [...RETIRED_SWEPT_SPELLINGS].join('|')
  const directHits = grep(`${READERS}\\((\\s*['"](${retiredAlt})['"])`)
    .split('\n')
    .filter(Boolean)
  check('no registry reader takes a retired-swept literal', directHits.length === 0, directHits.slice(0, 4).join(' · '))
  // (b) the ONE roster owner holds the healthy RAW shapes, at full breadth,
  //     and the spawn seam reads the roster from it.
  const gates = readFileSync(join(root, 'src/utils/workerRole.ts'), 'utf8')
  const spawn = readFileSync(join(root, 'src/daemon/headlessRun.ts'), 'utf8')
  const membersOf = (src: string): Set<string> => {
    const m = src.match(/RETIRED_SEAT_ENV_VARS[^=]*=\s*\[([^\]]*)\]/)
    return new Set([...(m?.[1] ?? '').matchAll(/'(MERCURY_[A-Z_0-9]+)'/g)].map(x => x[1]!))
  }
  const sameFive = (s: Set<string>): boolean =>
    s.size === RETIRED_SWEPT_SPELLINGS.size && [...s].every(v => RETIRED_SWEPT_SPELLINGS.has(v))
  check('workerRole sweeps exactly the five retired spellings (breadth never silently shrinks)', sameFive(membersOf(gates)))
  check(
    'headlessRun imports the roster from workerRole (one owner, never a second literal)',
    /import \{ LIVE_ROLE_ENV_VARS, RETIRED_SEAT_ENV_VARS \} from '\.\.\/utils\/workerRole\.js'/.test(spawn) &&
      !/RETIRED_SEAT_ENV_VARS[^=]*=\s*\[/.test(spawn),
  )
  check(
    'assertSingleRole reads the retired list RAW (process.env), the live roles through flagEnv',
    /RETIRED_SEAT_ENV_VARS\.filter\(v => process\.env\[v\] === '1'\)/.test(gates) &&
      /\.filter\(v => flagEnv\(v\) === '1'\)/.test(gates),
  )
  check(
    "headlessRun's swept spellings = the live roles' registered spellings + the retired five appended RAW",
    /LIVE_ROLE_ENV_VARS\.flatMap\(flagSpellings\), \.\.\.RETIRED_SEAT_ENV_VARS/.test(spawn) &&
      !/RETIRED_SEAT_ENV_VARS\.flatMap\(flagSpellings\)/.test(spawn),
  )
  // (c) the GENERIC array-flow law: any const array of MERCURY_* literals
  // whose identifier is fed to a registry reader must hold ONLY registered
  // members — a future row deletion of a still-swept name reds HERE instead
  // of throwing at runtime. THE FEEDING SHAPES (each a live idiom or the
  // next retirement's likely spelling — the first cut knew only
  // flatMap/map(flagSpellings) and filter(x => flagEnv|flagEnabled(, and the
  // the planted for-of over a retired spelling walked
  // straight past it): an array method whose callback calls a reader
  // (filter · forEach · some · every · find · findIndex · findLast · map ·
  // flatMap — arrow or point-free); a for-of loop whose body hands the loop
  // variable to a reader, as any argument (the flag name is stampFlagOnEnv's
  // SECOND argument); and a SPREAD into another const array that is itself
  // fed — members resolve through `...OTHER` to a bounded depth, so the
  // retired-five appended raw behind a live list can never be re-fed by a
  // later refactor of the combined array.
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
    // point-free: ID.map(flagEnv) · ID.flatMap(flagSpellings)
    if (new RegExp(`\\b${id}\\.${ARRAY_METHOD}\\(\\s*${READER_CALL}\\s*\\)`).test(text)) return true
    // an arrow callback that calls a reader: ID.filter(v => flagEnv(v) === '1')
    if (new RegExp(`\\b${id}\\.${ARRAY_METHOD}\\(\\s*\\(?\\s*\\w+[^)\\n]*\\)?\\s*=>[^\\n]*${READER_CALL}\\(`).test(text)) return true
    // a for-of loop whose body hands the loop variable to a reader
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
  check('every array fed to a registry reader holds only registered members (every feeding shape)', arrayFlowHits.length === 0, arrayFlowHits.slice(0, 4).join(' · '))
  // (d) self-tests — the needles bite (a pin that cannot fail proves nothing).
  // One synthetic file per shape; every one must be seen as FED, and the
  // one clean shape (a raw process.env sweep) must not.
  const retiredLiteral = "'MERCURY_" + "TANK'"
  const shapes: Array<[string, string, boolean]> = [
    ['flatMap(flagSpellings)', `const BAD = [${retiredLiteral}]\nconst x = BAD.flatMap(flagSpellings)`, true],
    ['filter arrow', `const BAD = [${retiredLiteral}]\nconst on = BAD.filter(v => flagEnv(v) === '1')`, true],
    ['forEach arrow', `const BAD = [${retiredLiteral}]\nBAD.forEach(v => { delete env[v]; deleteFlagEnv(v) })`, true],
    ['some arrow (parenthesised param)', `const BAD = [${retiredLiteral}]\nconst any = BAD.some((v) => flagEnabled(v))`, true],
    ['point-free map', `const BAD = [${retiredLiteral}]\nconst vals = BAD.map(flagEnv)`, true],
    ['for-of, reader on the loop variable', `const BAD = [${retiredLiteral}]\nfor (const v of BAD) if (flagEnv(v) === '1') n++`, true],
    ['for-of, the name as a LATER argument', `const BAD = [${retiredLiteral}]\nfor (const v of BAD) {\n  stampFlagOnEnv(env, v, '1')\n}`, true],
    ['spread into a fed array (transitive)', `const RET = [${retiredLiteral}]\nconst LIVE = ['MERCURY_SCRIBE']\nconst ALL = [...LIVE, ...RET]\nconst sp = ALL.flatMap(flagSpellings)`, true],
    ['clean: a RAW process.env sweep', `const RET = [${retiredLiteral}]\nconst set = RET.filter(v => process.env[v] === '1')\nfor (const v of RET) delete env[v]`, false],
  ]
  for (const [label, text, expectFed] of shapes) {
    const decls = declsOf(text)
    const fedIds = [...decls.keys()].filter(id => membersOfDecl(decls, id).some(m => !registered.has(m)) && feedsReader(id, text))
    check(`§7 self-test: ${label} ${expectFed ? 'trips' : 'does not trip'} the array-flow law`, (fedIds.length > 0) === expectFed, fedIds.join(','))
  }
  check(
    '§7 self-test: a planted direct-literal call trips the reader needle',
    new RegExp(`${READERS}\\((\\s*['"](${retiredAlt})['"])`).test("flagPair('MERCURY_" + "TANK', '0')"),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} FLAG-REGISTRY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FLAG-REGISTRY PROOFS PASS')

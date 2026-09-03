#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-bootenv-attribution.ts — the boot-env
//  ATTRIBUTION law: a saved boot-menu default the boot itself copied into
//  the environment is never "pinned by the real environment".
//
//    • realEnvPin is the ONE owner: a row is a real pin when one of its
//      registered spellings is present in the env AND is not the applier's
//      own stamp (the receipt MERCURY_BOOT_ENV_APPLIED names the stamps with
//      their values). Rows the real env already held before the apply
//      (envWins) stay real pins; every registered spelling counts.
//    • the snapshot resolver reads a self-applied row as source 'profile',
//      and the explicit apply answers no-change for it — never the env-wins
//      refusal; a real pin still refuses on the law.
//    • before any apply: nothing set ⇒ no pin; a present value ⇒ a real pin.
//      The receipt is per env object — an apply elsewhere excuses nothing.
//    • the receipt rides the env into children: an inherited copy reads as
//      a saved default WITHOUT an apply (the owned daemon's road); a child's
//      own apply undoes the copies and re-resolves the file (a changed or
//      cleared default reaches it); a value that differs from the receipt
//      is a real pin; the daemon-side and child-side snapshot ids agree (the
//      warm pool's settings-parity fingerprint); an unreadable receipt
//      excuses nothing.
//    • the default arguments read process.env and the config home's file.
//    • source pins: every reader of the env-pinned fact goes through the
//      owner — no second env-presence decision for menu rows outside it.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-bootenv-attribution.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── hermetic env, latched BEFORE any src import; the repo root is the cwd
//    (the src imports below are dynamic so the latches win) ──────────────────
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HERMETIC = mkdtempSync(join(tmpdir(), 'bootenv-attribution-'))
process.env.MERCURY_CONFIG_DIR = join(HERMETIC, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const k of ['MERCURY_HOME', 'MERCURY_ENTER_MENU', 'MERCURY_BOOT_ENV_APPLIED']) delete process.env[k]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('core-runtime — boot-env attribution')

const menu = await import('../../src/substrate/startupMenu.js')
const { FLAG_REGISTRY, flagSpellings } = await import('../../src/substrate/flagRegistry.js')
type Snapshot = ReturnType<typeof menu.resolveEffectiveSettingsSnapshot>
const rowOf = (snap: Snapshot, env: string) => snap.rows.find(r => r.env === env)
const snapshot = (env: NodeJS.ProcessEnv, path: string, sessionId = 'probe'): Snapshot =>
  menu.resolveEffectiveSettingsSnapshot({ sessionId, path, env })

// Two live menu rows from the registry itself: A carries two declared
// choices (a changed default needs a second value), B any declared choice.
const rowA = menu.STARTUP_MENU.find(r => r.options.length >= 2)!
const rowB = menu.STARTUP_MENU.find(r => r !== rowA && r.options.length >= 1)!
const A = rowA.env
const B = rowB.env
const a1 = rowA.options[0]!
const a2 = rowA.options[1]!
const b1 = rowB.options[0]!
check('fixture: two live menu rows with declared choices', A !== B && a1 !== a2, `${A} ${B}`)
// The harness's own shell must not pin the fixture rows.
for (const env of [A, B]) for (const sp of flagSpellings(env)) delete process.env[sp]

const path = join(HERMETIC, 'boot-env.json')
const saved = menu.saveBootDefaultsProfile({ [A]: a1, [B]: b1 }, path)
check('fixture: the profile saves both rows', saved.ok === true, JSON.stringify(saved))

let parentEnv: NodeJS.ProcessEnv = {}

// ── LAW ONE OWNER: a clean env, both rows applied ⇒ profile, never a pin ────
{
  const env: NodeJS.ProcessEnv = {}
  const r = menu.applyBootMenuEnv(path, env)
  check(
    'apply: both rows applied on a clean env, none env-won',
    r !== null && r.applied.length === 2 && r.envWins.length === 0,
    JSON.stringify(r),
  )
  const receipt = menu.bootEnvSelfApplied(env)
  check(
    'receipt: the applier stamps every spelling it wrote with its value',
    flagSpellings(A).every(sp => receipt.get(sp) === a1) && flagSpellings(B).every(sp => receipt.get(sp) === b1),
    JSON.stringify([...receipt]),
  )
  check('owner: a self-applied row is not a real pin', menu.realEnvPin(A, env) === null && menu.realEnvPin(B, env) === null)
  const snap = snapshot(env, path)
  check(
    'snapshot: both rows read source profile with the saved values',
    rowOf(snap, A)?.source === 'profile' &&
      rowOf(snap, A)?.value === a1 &&
      rowOf(snap, B)?.source === 'profile' &&
      rowOf(snap, B)?.value === b1,
    JSON.stringify([rowOf(snap, A), rowOf(snap, B)]),
  )
  check(
    'snapshot: no other row is pinned (nothing else is set)',
    snap.rows.every(row => row.env === A || row.env === B || row.source === 'default'),
  )
  const receipts = menu.evaluateExplicitApply(snap, menu.readBootDefaultsProfile(path))
  const byEnv = new Map(receipts.map(x => [x.env, x]))
  check(
    'explicit apply: a self-applied row answers no-change, never the env-wins refusal',
    byEnv.get(A)?.outcome === 'no-change' && byEnv.get(B)?.outcome === 'no-change',
    JSON.stringify([byEnv.get(A), byEnv.get(B)]),
  )
  check('explicit apply: no row at all refuses on the env-wins law', receipts.every(x => !/env always wins/.test(x.reason)))
  parentEnv = env
}

// ── LAW REAL ENV WINS: a row the real env held before the apply stays a pin ─
{
  const env: NodeJS.ProcessEnv = { [A]: a2 }
  const r = menu.applyBootMenuEnv(path, env)
  check(
    'apply: the real-env row is env-won and never overwritten; the other applies',
    r !== null && r.envWins.length === 1 && r.envWins[0] === A && env[A] === a2 && r.applied.length === 1 && env[B] === b1,
    JSON.stringify(r),
  )
  const receipt = menu.bootEnvSelfApplied(env)
  check('receipt: names only what was applied', receipt.has(B) && !receipt.has(A), JSON.stringify([...receipt]))
  check(
    'owner: the env-won row is a real pin; the applied row is not',
    menu.realEnvPin(A, env)?.value === a2 && menu.realEnvPin(B, env) === null,
  )
  const snap = snapshot(env, path)
  check(
    'snapshot: the real pin reads process-env with the env value; the other profile',
    rowOf(snap, A)?.source === 'process-env' && rowOf(snap, A)?.value === a2 && rowOf(snap, B)?.source === 'profile',
    JSON.stringify([rowOf(snap, A), rowOf(snap, B)]),
  )
  const byEnv = new Map(menu.evaluateExplicitApply(snap, menu.readBootDefaultsProfile(path)).map(x => [x.env, x]))
  check(
    'explicit apply: the real pin refuses on the env-wins law; the applied row is no-change',
    byEnv.get(A)?.outcome === 'refused' &&
      /env always wins/.test(byEnv.get(A)?.reason ?? '') &&
      byEnv.get(B)?.outcome === 'no-change',
    JSON.stringify(byEnv.get(A)),
  )
  // The same value as the saved default, set by the real env, is still a pin.
  const same: NodeJS.ProcessEnv = { [A]: a1 }
  menu.applyBootMenuEnv(path, same)
  check(
    'owner: a real-env value equal to the saved default is still a real pin',
    menu.realEnvPin(A, same)?.value === a1 && rowOf(snapshot(same, path), A)?.source === 'process-env',
  )
}

// ── LAW EVERY SPELLING: each registered spelling set in the real env is a pin
{
  for (const spelling of flagSpellings(A)) {
    const env: NodeJS.ProcessEnv = { [spelling]: a1 }
    check(
      `owner: spelling ${spelling} set in the real env is a real pin (no apply)`,
      menu.realEnvPin(A, env)?.spelling === spelling && rowOf(snapshot(env, path), A)?.source === 'process-env',
    )
  }
}

// ── LAW BEFORE ANY APPLY: no false pin; a present value is a pin; per object ─
{
  const clean: NodeJS.ProcessEnv = {}
  const snap = snapshot(clean, path)
  check(
    'before apply: nothing set ⇒ no row reads process-env; the saved rows read profile',
    snap.rows.every(r => r.source !== 'process-env') && rowOf(snap, A)?.source === 'profile',
    JSON.stringify(rowOf(snap, A)),
  )
  check('before apply: the owner answers null for an unset row', menu.realEnvPin(A, clean) === null)
  const pinned: NodeJS.ProcessEnv = { [B]: b1 }
  check(
    'before apply: a present value is a real pin, even one an earlier apply wrote elsewhere (the receipt is per env object)',
    menu.realEnvPin(B, pinned)?.value === b1 && rowOf(snapshot(pinned, path), B)?.source === 'process-env',
  )
}

// ── LAW INHERITED: the receipt rides the env into children ──────────────────
{
  // The owned daemon: a copy of the interactive boot's env, never applies.
  const daemon: NodeJS.ProcessEnv = { ...parentEnv }
  check(
    "inherited: a child that never applies reads the parent's copies as saved defaults",
    menu.realEnvPin(A, daemon) === null &&
      rowOf(snapshot(daemon, path), A)?.source === 'profile' &&
      rowOf(snapshot(daemon, path), B)?.source === 'profile',
  )
  const daemonId = snapshot(daemon, path, 'x').snapshotId
  // A runner the daemon spawns: a copy of the daemon's env, applies the file.
  const runner: NodeJS.ProcessEnv = { ...daemon }
  const rr = menu.applyBootMenuEnv(path, runner)
  check(
    "inherited: a child's own apply re-applies the file over the copies — never env-won",
    rr !== null && rr.envWins.length === 0 && rr.applied.length === 2 && runner[A] === a1 && runner[B] === b1,
    JSON.stringify(rr),
  )
  check(
    "parity: the daemon-side and child-side snapshot ids agree (the warm pool's fingerprint)",
    snapshot(runner, path, 'y').snapshotId === daemonId,
  )
  // The profile moves: A changes, B is cleared.
  const moved = menu.saveBootDefaultsProfile({ [A]: a2 }, path)
  check('fixture: the profile moves (A changes, B cleared)', moved.ok === true, JSON.stringify(moved))
  const runner2: NodeJS.ProcessEnv = { ...daemon }
  const rr2 = menu.applyBootMenuEnv(path, runner2)
  check(
    'inherited: a changed default reaches the child; a cleared one leaves it (rides the default)',
    rr2 !== null && rr2.applied.length === 1 && runner2[A] === a2 && runner2[B] === undefined,
    JSON.stringify({ rr2, a: runner2[A], b: runner2[B] }),
  )
  check(
    "inherited: the child's receipt names only what it applied",
    menu.bootEnvSelfApplied(runner2).get(A) === a2 && !menu.bootEnvSelfApplied(runner2).has(B),
  )
  const snap2 = snapshot(runner2, path)
  check(
    'snapshot: after the move the child reads A profile (new value), B default',
    rowOf(snap2, A)?.source === 'profile' && rowOf(snap2, A)?.value === a2 && rowOf(snap2, B)?.source === 'default',
    JSON.stringify([rowOf(snap2, A), rowOf(snap2, B)]),
  )
  check(
    'parity: the daemon (still carrying the old copies) and the child agree after the move',
    snapshot(daemon, path, 'x').snapshotId === snapshot(runner2, path, 'y').snapshotId,
  )
  // A parent's deliberate different value is a real pin.
  const deliberate: NodeJS.ProcessEnv = { ...daemon, [A]: a2 }
  check('inherited: a value that differs from the receipt is a real pin', menu.realEnvPin(A, deliberate)?.value === a2)
  const rr3 = menu.applyBootMenuEnv(path, deliberate)
  check(
    "inherited: the differing value is env-won by the child's apply (never overwritten); the cleared copy still leaves",
    rr3 !== null && rr3.envWins.includes(A) && deliberate[A] === a2 && deliberate[B] === undefined,
    JSON.stringify(rr3),
  )
  // An unreadable receipt excuses nothing.
  const garbled: NodeJS.ProcessEnv = { ...daemon, MERCURY_BOOT_ENV_APPLIED: 'not json {' }
  check(
    'inherited: an unreadable receipt attributes nothing to the boot (a present value is a pin)',
    menu.bootEnvSelfApplied(garbled).size === 0 && menu.realEnvPin(A, garbled)?.value === a1,
  )
}

// ── LAW DEFAULT ARGUMENTS: process.env + the config home's file ─────────────
{
  const home = menu.bootEnvPath()
  check("default path: the config home's boot-env.json", home === join(process.env.MERCURY_CONFIG_DIR!, 'boot-env.json'), home)
  const wrote = menu.saveBootDefaultsProfile({ [B]: b1 }, home)
  check('fixture: a profile in the config home', wrote.ok === true, JSON.stringify(wrote))
  const r = menu.applyBootMenuEnv()
  check(
    'default env: the apply stamps process.env and its receipt',
    r !== null && r.applied.length === 1 && process.env[B] === b1 && menu.bootEnvSelfApplied().get(B) === b1,
    JSON.stringify(r),
  )
  check('default env: the owner reads process.env — the applied row is not a pin', menu.realEnvPin(B) === null)
  check('default env: bootEnvAppliedKeys (the in-process receipt) still names the apply', menu.bootEnvAppliedKeys().has(B))
  check(
    'default env: the snapshot on process.env reads the row as profile',
    rowOf(menu.resolveEffectiveSettingsSnapshot({ sessionId: 'p' }), B)?.source === 'profile',
  )
  for (const sp of flagSpellings(B)) delete process.env[sp]
  delete process.env.MERCURY_BOOT_ENV_APPLIED
}

// ── SOURCE PINS: one owner, every reader through it ─────────────────────────
{
  const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')
  const owner = read('src/substrate/startupMenu.ts')
  check(
    'owner: the applier stamps the registered receipt spelling',
    owner.includes("const BOOT_ENV_APPLIED_MARKER = 'MERCURY_BOOT_ENV_APPLIED'") &&
      owner.includes('stampFlagOnEnv(env, BOOT_ENV_APPLIED_MARKER, JSON.stringify(receipt))'),
  )
  const undo = owner.indexOf('for (const [spelling, value] of bootEnvSelfApplied(env))')
  check(
    'owner: the applier undoes inherited copies before it resolves the file',
    undo > 0 && undo < owner.indexOf('const appliedRows = new Set<string>()'),
  )
  const resolver = owner.slice(
    owner.indexOf('export function resolveEffectiveSettingsSnapshot'),
    owner.indexOf('// ── the CONFIG-BACKED Coordinator row'),
  )
  check(
    'owner: the snapshot resolver decides a pin through realEnvPin only',
    resolver.includes('realEnvPin(row.env, processEnv)') && !/processEnv\[[^\]]+\]\s*!==\s*undefined/.test(resolver),
  )
  const registryRow = FLAG_REGISTRY.find(f => f.env === 'MERCURY_BOOT_ENV_APPLIED')
  check(
    'registry: the receipt is a registered self-stamped value row owned by the applier',
    registryRow?.kind === 'value' && registryRow.selfStamped === true && registryRow.consumer === 'src/substrate/startupMenu.ts',
  )
  const readers = ['src/commands/caching/caching.tsx', 'src/utils/readiness.ts', 'src/utils/healthReport.ts']
  for (const f of readers) {
    const text = read(f)
    check(`reader ${f}: imports the one owner`, /import \{[^}]*\brealEnvPin\b[^}]*\} from '(?:\.\.\/)+substrate\/startupMenu\.js'/.test(text))
    check(`reader ${f}: never re-decides attribution from the in-process receipt`, !text.includes('bootEnvAppliedKeys'))
  }
  const screen = read('src/components/BootSettingsScreen.tsx')
  check(
    "screen: the boot menu paints env-pinned from the snapshot's source alone",
    screen.includes("const envPinned = effective?.source === 'process-env'") && !screen.includes('process.env'),
  )
  const files = execSync('git ls-files -z src', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(f => /\.(ts|tsx)$/.test(f) && f !== 'src/substrate/startupMenu.ts')
  const strays = files.filter(f => read(f).includes('bootEnvAppliedKeys'))
  check('census: no src file outside the owner reads the in-process receipt for attribution', strays.length === 0, strays.join(', '))
  const sourceDeciders = files.filter(f => f !== 'src/components/BootSettingsScreen.tsx' && read(f).includes("'process-env'"))
  check(
    'census: the process-env verdict is minted by the owner and consumed by the boot menu only',
    sourceDeciders.length === 0,
    sourceDeciders.join(', '),
  )
}

// ── the admission snapshot: this process's boot values, recorded once ─────
console.log('admission snapshot: the boot records once; the menu reads it, never a later profile')
{
  menu.__resetBootAdmissionSnapshotForTests()
  check('no boot recorded ⇒ no admission snapshot (a fresh resolution stands in)', menu.bootAdmissionSnapshot() === null)
  const admitPath = join(HERMETIC, 'admission-boot-env.json')
  menu.saveBootDefaultsProfile({ [A]: a1 }, admitPath)
  const admitted = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'admit-1', path: admitPath, env: {} })
  menu.recordBootAdmissionSnapshot(admitted)
  const rowA = (s: { rows: Array<{ env: string; value: string | null }> } | null): string | null | undefined => s?.rows.find(r => r.env === A)?.value
  check('the admission holds the boot value', rowA(menu.bootAdmissionSnapshot()) === a1)
  menu.saveBootDefaultsProfile({ [A]: a2 }, admitPath)
  const fresh = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'admit-1', path: admitPath, env: {} })
  check('a later save moves a fresh resolution', rowA(fresh) === a2)
  check('the admission snapshot keeps the boot value across the save (the menu\'s this-session line reads THIS)', rowA(menu.bootAdmissionSnapshot()) === a1 && menu.bootAdmissionSnapshot()?.snapshotId === admitted.snapshotId)
  menu.__resetBootAdmissionSnapshotForTests()
  const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const mainSrc = readSrc('src/main.tsx')
  check('main records the admission right after the apply, once', /applyBootMenuEnv\(\);[\s\S]{0,400}recordBootAdmissionSnapshot\(resolveEffectiveSettingsSnapshot\(\{ sessionId: getSessionId\(\) \}\)\);/.test(mainSrc) && (mainSrc.match(/recordBootAdmissionSnapshot\(/g) ?? []).length === 1)
  const screenSrc = readSrc('src/components/BootSettingsScreen.tsx')
  check("the boot menu's this-session line reads the admission first", screenSrc.includes('bootAdmissionSnapshot() ?? resolveEffectiveSettingsSnapshot({ sessionId: getSessionId(), path })'))
}

rmSync(HERMETIC, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nboot-env attribution: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nboot-env attribution: green (${checks} checks)`)

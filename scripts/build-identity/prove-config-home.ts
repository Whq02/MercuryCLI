#!/usr/bin/env bun
// ============================================================================
//  scripts/build-identity/prove-config-home.ts
//  PROOF: the stamped build owns its config home BY DEFAULT — never the
//  default's ~/.claude — while explicit env keeps absolute precedence and
//  bare-stamp builds stay byte-identical.
//    truth table (via the MACRO stamp-sim + memoize cache reset):
//      explicit MERCURY_CONFIG_DIR  → wins on BOTH builds
//      unset, MERCURY_HOME          → MERCURY_HOME
//      unset, no home env           → ~/.mercury — stamp-independent, never
//        the default's ~/.claude, and never any other sibling home
//    + the ONE-HOME law: no other config-home spelling survives anywhere in
//      the source, the release launchers, the ops scripts, or the operator
//      docs — a second home name is the home-flip class.
//    + the two proof-harness pins that keep bun-writers and dist children on
//      ONE home (gate unit + render-tui).
//  Run:  ~/.bun/bin/bun run scripts/build-identity/prove-config-home.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const envUtils = await import('../../src/utils/envUtils.js')
const home = homedir()
type Memoized = { cache: { clear?: () => void } }
const reset = (): void => {
  ;(envUtils.getMercuryHome as unknown as Memoized).cache.clear?.()
}
const setStamp = (on: boolean): void => {
  if (on) (globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>).MACRO
}
const probe = (fork: boolean, ccd: string | undefined, mh: string | undefined): string => {
  setStamp(fork)
  if (ccd === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = ccd
  if (mh === undefined) delete process.env.MERCURY_HOME
  else process.env.MERCURY_HOME = mh
  reset()
  return envUtils.getMercuryHome()
}

const saved = { mcd: process.env.MERCURY_CONFIG_DIR, mh: process.env.MERCURY_HOME }
const mercuryDefault = join(home, '.mercury').normalize('NFC')

console.log('\nsovereign config home — truth table (stamp-independent)')
check('explicit env wins (version stamp)', probe(true, '/tmp/explicit-a', '/tmp/mh') === '/tmp/explicit-a')
check('explicit env wins (bare stamp — same behavior)', probe(false, '/tmp/explicit-b', undefined) === '/tmp/explicit-b')
check('unset + MERCURY_HOME → MERCURY_HOME', probe(true, undefined, '/tmp/mercury-home') === '/tmp/mercury-home')
const envlessDefault = probe(true, undefined, undefined)
check('unset → ~/.mercury (the one default, whatever else exists beside it)', envlessDefault === mercuryDefault, envlessDefault)
check("unset → never the default's ~/.claude", envlessDefault !== join(home, '.claude').normalize('NFC'), envlessDefault)
// a mis-stamped build resolves the SAME default instead of silently bleeding
// into the default's home.
check('bare stamp + unset → the same default (stamp-independence)', probe(false, undefined, undefined) === envlessDefault)
check('memoize keys on BOTH env inputs (flip MERCURY_HOME re-resolves)', probe(true, undefined, '/tmp/mh2') === '/tmp/mh2')

console.log('\nkeychain identity follows the RESOLVED home (fork)')
// The launcher exports MERCURY_CONFIG_DIR=<its own resolution> — pin the
// explicit leg to the resolver's OWN env-less answer: both must hash to ONE
// service (no re-login); env-less fork must NEVER read the external
// un-suffixed keychain entry; bare env-presence semantics unchanged.
const kc = await import('../../src/utils/secureStorage/macOsKeychainHelpers.js')
const svc = (fork: boolean, ccd: string | undefined, mh: string | undefined): string => {
  probe(fork, ccd, mh)
  return kc.getMacOsKeychainStorageServiceName()
}
const launcherSvc = svc(true, envlessDefault, undefined)
const envlessSvc = svc(true, undefined, undefined)
check('launcher (env=resolved default) and env-less fork share ONE service', launcherSvc === envlessSvc, `${launcherSvc} vs ${envlessSvc}`)
check('the Mercury service is suffixed (never the foreign bare entry)', /-[0-9a-f]{8}$/.test(envlessSvc), envlessSvc)
check('an explicit ~/.claude uses the bare (foreign) service', !/-[0-9a-f]{8}$/.test(svc(true, join(home, '.claude'), undefined)))
// keychain identity keys on the RESOLVED home, stamp-independent — a bare
// VERSION behaves exactly like the stamped rows above.
check('bare stamp env-less service is Mercury\'s (suffixed, stamp-independence)', svc(false, undefined, undefined) === envlessSvc)
check('bare stamp + explicit ~/.claude uses the bare service (resolved-home keying)', !/-[0-9a-f]{8}$/.test(svc(false, join(home, '.claude'), undefined)))

console.log('\ndoctor coherence keys on the AUTH home (a foreign slot is not a split)')
// Operator report: with an in-session /accounts slot pointing the
// credential store at the foreign ~/.claude, /doctor's config-home check cried
// the un-suffixed external keychain service for a non-default home — a
// false positive: the service DERIVES from the auth scope (by design the slot
// repoints ONLY the credential store), so the coherence predicate must key on
// getAuthConfigHomeDir(), with the helper's own NFC compare.
{
  probe(true, undefined, undefined)
  envUtils.setAuthScope(join(home, '.claude'))
  try {
    const slottedSvc = kc.getMacOsKeychainStorageServiceName()
    check("a foreign ~/.claude slot reads the default's bare service (by design)", !/-[0-9a-f]{8}$/.test(slottedSvc), slottedSvc)
    const authHome = envUtils.getAuthConfigHomeDir()
    const defaultAuthHome = authHome === join(home, '.claude').normalize('NFC')
    check('the auth-home-keyed predicate does NOT flag the slot', !(!defaultAuthHome && !/-[0-9a-f]{8}$/.test(slottedSvc)))
    check('…while the session home stays ~/.mercury (never ~/.claude)', envUtils.getMercuryHome() === mercuryDefault, envUtils.getMercuryHome())
  } finally {
    envUtils.clearAuthScope()
  }
  // At rest the auth home IS the session home — the split test still bites:
  // a non-default auth home with a bare service must flag.
  const restAuthHome = envUtils.getAuthConfigHomeDir()
  check('at rest the auth home is the resolved session home', restAuthHome === envUtils.getMercuryHome())
  check('at rest the env-less service is suffixed (the split test still bites on a bare one)', /-[0-9a-f]{8}$/.test(kc.getMacOsKeychainStorageServiceName()))
  // Source-lock the doctor to the auth-home predicate (never the session home).
  const doctorSrc = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf-8')
  check('doctor config-home keys the keychain test on getAuthConfigHomeDir()', doctorSrc.includes('const authHome = getAuthConfigHomeDir()') && doctorSrc.includes('non-default auth home'))
  check("doctor mirrors the helper's NFC compare", doctorSrc.includes(".claude').normalize('NFC')"))
  check('a live slot is NAMED in the ok evidence, never flagged', doctorSrc.includes('auth scope slotted →'))
}

console.log('\nstore-plane agreement — every inline resolver follows the ONE resolver')
// The fable-audit regression class: modules that re-derived `env ?? ~/.claude`
// inline SPLIT from the sovereign default on env-less fork runs (daemon plane
// vs store; the default's ~/.claude.json global config). Source-lock the delegates.
const controlSocketSrc = readFileSync(join(ROOT, 'src', 'daemon', 'controlSocket.ts'), 'utf-8')
check('daemon controlSocket configHome delegates to getMercuryHome', /function configHome\(\): string \{\s*\n\s*return getMercuryHome\(\)/.test(controlSocketSrc))
// The delegation contract: "env-less lands inside the ONE resolved home" (no
// inline `?? ~/.claude` re-derivation anywhere).
const envSrc = readFileSync(join(ROOT, 'src', 'utils', 'env.ts'), 'utf-8')
// the monolith is Mercury-NAMED inside the resolved home; env-less
// resolution rides getMercuryHome (the ONE resolver) — a plain delegation,
// `const home = getMercuryHome()`, never a compat-env-first ternary.
check('getGlobalMercuryFile env-less defaults into the resolved home (Mercury-named)', envSrc.includes('const home = getMercuryHome()') && envSrc.includes('`.mercury${suffix}.json`'))
const envUtilsSrc = readFileSync(join(ROOT, 'src', 'utils', 'envUtils.ts'), 'utf-8')
check('envUtils source carries no ~/.claude default arm', !envUtilsSrc.includes(".claude').normalize"))
check('envUtils source never probes the filesystem to pick a home (no existence rung)', !/existsSync\([^)]*\.mercury/.test(envUtilsSrc))
const accountViewSrc = readFileSync(join(ROOT, 'src', 'components', 'mercury-ui', 'parity', 'AccountView.tsx'), 'utf-8')
check('/accounts scope row keys on the RESOLVED home, not env presence', accountViewSrc.includes('tildify(getMercuryHome(), home)') && !accountViewSrc.includes('process.env.MERCURY_CONFIG_DIR'))

console.log('\nthe ONE-HOME law — no other config-home spelling survives')
// A second home name anywhere in the estate is the home-flip class (two
// homes, one silently chosen). The sweep covers the runtime source, the
// release launcher templates, the ops scripts and their shell twins, the
// gate harness, the pre-boot splash, and the operator-facing docs. The
// composed needle keeps this file from matching itself.
const RETIRED_HOME = new RegExp(['\\.', 'her', 'mes\\b', '|', 'HER', 'MES_HOME'].join(''), 'i')
const SWEEP_SCOPES = [
  'src',
  'scripts/release',
  'scripts/ops',
  'scripts/lib',
  'scripts/gate',
  'scripts/build-identity',
  'assets/splash',
  'assets/vulcan',
  'README.md',
  'AGENTS.md',
  'docs',
]
const trackedFiles = execSync(`git ls-files -z -- ${SWEEP_SCOPES.join(' ')}`, { cwd: ROOT })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter(p => !/\.(png|jpe?g|gif|ico|icns|pdf|wasm|woff2?|ttf|otf|node|zip|gz|tgz|jar|mp[34]|exe|dylib|so|bin|zst|tar)$/i.test(p))
const homeHits: string[] = []
for (const path of trackedFiles) {
  let content: string
  try {
    content = readFileSync(join(ROOT, path), 'utf8')
  } catch {
    continue
  }
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (RETIRED_HOME.test(lines[i]!)) homeHits.push(`${path}:${i + 1}`)
  }
}
check(`no other config-home spelling in ${trackedFiles.length} swept files`, homeHits.length === 0, homeHits.slice(0, 10).join(' · '))
// The registry reader is single-spelling: no alias field, no fallback read.
const registrySrc = readFileSync(join(ROOT, 'src', 'substrate', 'flagRegistry.ts'), 'utf-8')
check('the flag registry carries no alias field', !/\blegacy\??:/.test(registrySrc))
check('flagEnv reads exactly the registered spelling', /return process\.env\[spec\.env\]\n\}/.test(registrySrc))

console.log('\nharness pins — one home for bun writers + dist children')
const gateUnit = readFileSync(join(ROOT, 'scripts', 'gate', 'run-suite.sh'), 'utf-8')
// An inherited pin is honoured; a suite given no home gets its OWN scratch,
// seeded through the ONE seeder — never the default's ~/.claude.
check(
  'gate unit pins an explicit home for every suite (inherited pin, else its own seeded scratch)',
  gateUnit.includes('if [ -z "${MERCURY_CONFIG_DIR:-}" ]; then') &&
    gateUnit.includes('export MERCURY_CONFIG_DIR="$outdir/$dom.config-home"') &&
    gateUnit.includes('scripts/lib/firstRunSeed.ts" "$MERCURY_CONFIG_DIR"'),
)
check('gate unit carries no ~/.claude fallback', !gateUnit.includes('$HOME/.claude'))
check(
  'gate unit pins the scratch home on the ONE spelling (MERCURY_HOME)',
  gateUnit.includes('export MERCURY_HOME="${MERCURY_HOME:-') && !/export [A-Z]+_HOME="\$MERCURY_HOME"/.test(gateUnit),
)
// The vshot child ALWAYS gets an explicit home: renderScenarios' CONFIG_HOME,
// the proof's own (scripts/lib/proofHome.ts — the inherited pin, else a fresh
// seeded scratch); the foreign ~/.claude fallback is absent from the whole chain.
const renderTui = readFileSync(join(ROOT, 'scripts', 'ui', 'render-tui.ts'), 'utf-8')
check('render-tui pins an explicit home for the vshot child (inherited pin, else the proof home)', renderTui.includes('MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME'))
check('render-tui takes that home from renderScenarios', /import \{[^}]*\bCONFIG_HOME\b[^}]*\} from '\.\/renderScenarios\.ts'/.test(renderTui))
const renderScenarios = readFileSync(join(ROOT, 'scripts', 'ui', 'renderScenarios.ts'), 'utf-8')
check('renderScenarios resolves CONFIG_HOME through the proof-home helper', renderScenarios.includes('export const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])'))
const proofHome = readFileSync(join(ROOT, 'scripts', 'lib', 'proofHome.ts'), 'utf-8')
check(
  'the proof-home helper makes its own seeded scratch and never falls back to the foreign ~/.claude',
  !proofHome.includes("'.claude'") && proofHome.includes("mkdtempSync(join(tmpdir(), 'mercury-proof-home-'))") && proofHome.includes('seedFirstRun(home,'),
)
check(
  'neither the driver nor render-tui spells the base fallback for a child home',
  !renderTui.includes("join(homedir(), '.claude')") && !renderScenarios.includes("join(homedir(), '.claude')"),
)
const owned = readFileSync(join(ROOT, 'src', 'daemon', 'ownedDaemon.ts'), 'utf-8')
check('owned daemons stamp the RESOLVED home (store-identity gating)', owned.includes('env.MERCURY_CONFIG_DIR = getMercuryHome()'))

// ---- privacy floor: the home is owner-only ----
if (process.platform !== 'win32') {
  const { mkdtempSync, rmSync, statSync: st, mkdirSync: mkd, chmodSync: chm } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const scratchRoot = mkdtempSync(join(tmpdir(), 'cfg-home-priv-'))
  // fresh create → 0700
  const freshHome = join(scratchRoot, 'fresh-home')
  probe(true, freshHome, undefined)
  envUtils.ensurePrivateConfigHome()
  check('fresh home created 0700', (st(freshHome).mode & 0o777) === 0o700)
  // existing loose home → tightened to owner-only, owner bits preserved
  const looseHome = join(scratchRoot, 'loose-home')
  mkd(looseHome)
  chm(looseHome, 0o755)
  probe(true, looseHome, undefined)
  envUtils.ensurePrivateConfigHome()
  check('existing 0755 home tightened to 0700', (st(looseHome).mode & 0o777) === 0o700)
  // main() wires the floor on the boot path
  const mainSrc = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf-8')
  check('main() calls ensurePrivateConfigHome at boot', mainSrc.includes('ensurePrivateConfigHome()'))
  rmSync(scratchRoot, { recursive: true, force: true })
}

// restore
if (saved.mcd === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = saved.mcd
if (saved.mh === undefined) delete process.env.MERCURY_HOME
else process.env.MERCURY_HOME = saved.mh
reset()

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ config home — ALL CHECKS PASS')

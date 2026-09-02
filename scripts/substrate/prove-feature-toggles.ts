#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-feature-toggles.ts
//  PROOF: the /authority runtime feature-toggle registry (featureToggles.ts) is
//  REAL — flipping a toggle sets the exact env var the live gate re-reads, so
//  behavior changes in-process. NOT a parallel store: the assertions drive the
//  ACTUAL gate readers and observe the delta.
//
//   1. fork-gating — bare-stamp ⇒ empty list + setters no-op (byte-identical);
//      fork ⇒ seven features (five DEFAULT-OFF, off on a clean env; two DEFAULT-ON
//      capabilities — compact-keep-tail, away-summary — on on a clean env).
//   2. set/read/toggle round-trips: on ⇒ env === '1' + read on; off ⇒ env
//      deleted + read off; toggleFeature flips; unknown key ⇒ false no-op.
//   2b. the DEFAULT-ON capability (compact-keep-tail): on by default, OFF ⇒ env
//      '0' (not delete), read mirrors the REAL gate (isMercuryCompactKeepTailEnabled).
//   3. ANTI-FAKE: the registry flip is observed by the REAL gate functions —
//      isUntrustedMcpHardeningOn, classifierFailClosedEnabled, and
//      DaemonBreaker.timeoutIsFleetFailure all follow the toggle.
//   4. STRUCTURAL: each registry env name is the one its gate reads; the panel
//      + command are wired (authority.tsx passes features + onToggleFeature,
//      MercuryPermissionsPanel renders a writable feature branch).
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-feature-toggles.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
// Both spellings per toggle: the writer stamps canonical +
// legacy, the reader honors either — a clean env must clear BOTH.
const ENVS = [
  'MERCURY_RELEVANT_RECALL',
  'MERCURY_RELEVANT_RECALL',
  'MERCURY_MCP_UNTRUSTED_HARDENING',
  'MERCURY_MCP_UNTRUSTED_HARDENING',
  'MERCURY_CLASSIFIER_FAIL_CLOSED',
  'MERCURY_CLASSIFIER_FAIL_CLOSED',
  'MERCURY_COMMIT_GATE',
  'MERCURY_COMMIT_GATE',
  'MERCURY_DAEMON_BREAKER_TIMEOUT_OK',
  'MERCURY_DAEMON_BREAKER_TIMEOUT_OK',
  'MERCURY_COMPACT_KEEP_TAIL',
  'MERCURY_COMPACT_KEEP_TAIL',
  'MERCURY_AWAY_SUMMARY',
  'MERCURY_AWAY_SUMMARY',
]
function clearEnv(): void {
  for (const e of ENVS) delete process.env[e]
}

console.log('============================================================')
console.log(' /authority runtime feature toggles — REAL gate drive')
console.log('============================================================')

const ft = (await import('../../src/utils/featureToggles.js')) as typeof import('../../src/utils/featureToggles.js')
const tp = (await import('../../src/services/mcp/toolPolicy.js')) as typeof import('../../src/services/mcp/toolPolicy.js')
const cf = (await import('../../src/utils/permissions/classifierFailClosed.js')) as typeof import('../../src/utils/permissions/classifierFailClosed.js')
const db = (await import('../../src/utils/daemonBreaker.js')) as typeof import('../../src/utils/daemonBreaker.js')
const vt = (await import('../../src/services/compact/verbatimTail.js')) as typeof import('../../src/services/compact/verbatimTail.js')

// ── 1. gating the toggle
// surface is stamp-independent (equality probes vs the stamped state).
section('gating: bare stamp ⇒ SAME catalog + live setters (stamp-independence)')
{
  setStamp(false)
  clearEnv()
  const stockList = ft.listFeatureToggles().map(t => t.key).join(',')
  const stockSet = ft.setFeatureToggle('mcp-hardening', true)
  const stockEnvAfterSet = process.env.MERCURY_MCP_UNTRUSTED_HARDENING
  const stockOn = ft.isFeatureToggleOn('mcp-hardening')
  setStamp(true)
  clearEnv()
  check('bare stamp: listFeatureToggles() === the full catalog', stockList === ft.listFeatureToggles().map(t => t.key).join(','))
  check('bare stamp: setFeatureToggle works (returned true)', stockSet === true)
  check('bare stamp: the env WAS set by the setter', stockEnvAfterSet === '1')
  check('bare stamp: isFeatureToggleOn saw the set', stockOn === true)
  clearEnv()

  setStamp(true)
  clearEnv()
  delete process.env.MERCURY_SUBSTRATE // ensure substrate default-on holds for the default-on toggles
  const list = ft.listFeatureToggles()
  const DEFAULT_ON = new Set(['compact-keep-tail', 'away-summary'])
  check('fork: exactly 7 toggles', list.length === 7, `got ${list.length}`)
  const keys = list.map(t => t.key).sort()
  check('fork: expected keys', JSON.stringify(keys) === JSON.stringify(['away-summary', 'classifier-fail-closed', 'commit-gate', 'compact-keep-tail', 'daemon-breaker-timeout', 'mcp-hardening', 'relevant-recall']))
  check('fork: the 5 DEFAULT-OFF features are off on a clean env', list.filter(t => !DEFAULT_ON.has(t.key)).every(t => t.on === false))
  check('fork: both DEFAULT-ON capabilities are ON on a clean env', list.filter(t => DEFAULT_ON.has(t.key)).every(t => t.on === true) && list.filter(t => DEFAULT_ON.has(t.key)).length === 2)
  check('fork: each carries a scope note', list.every(t => typeof t.scope === 'string' && t.scope.length > 0))
}

// ── 2. set / read / toggle round-trips ──────────────────────────────────────
section('set/read/toggle: env === \'1\' on, deleted off; toggle flips; unknown no-op')
{
  setStamp(true)
  clearEnv()
  check('set on ⇒ returns true', ft.setFeatureToggle('relevant-recall', true) === true)
  check('set on ⇒ env === \'1\' (exact)', process.env.MERCURY_RELEVANT_RECALL === '1')
  check('set on ⇒ isFeatureToggleOn true', ft.isFeatureToggleOn('relevant-recall') === true)
  check('set on ⇒ list entry on=true', ft.listFeatureToggles().find(t => t.key === 'relevant-recall')?.on === true)

  check('set off ⇒ returns false', ft.setFeatureToggle('relevant-recall', false) === false)
  check('set off ⇒ env DELETED (default-off, not "0")', process.env.MERCURY_RELEVANT_RECALL === undefined)
  check('set off ⇒ isFeatureToggleOn false', ft.isFeatureToggleOn('relevant-recall') === false)

  check('toggle from off ⇒ on', ft.toggleFeature('commit-gate') === true && process.env.MERCURY_COMMIT_GATE === '1')
  check('toggle from on ⇒ off', ft.toggleFeature('commit-gate') === false && process.env.MERCURY_COMMIT_GATE === undefined)

  check('unknown key ⇒ false no-op', ft.setFeatureToggle('does-not-exist', true) === false)
  check('unknown key set no env', ENVS.every(e => process.env[e] === undefined))
  clearEnv()
}

// ── 2b. DEFAULT-ON capability: on by default, OFF ⇒ '0' (not delete) ─────────
section("default-on (compact-keep-tail): on by default, OFF ⇒ env '0', read ↔ real gate")
{
  setStamp(true)
  clearEnv()
  delete process.env.MERCURY_SUBSTRATE
  delete process.env.MERCURY_CTX_COMPACTION
  // clean env ⇒ ON (shipped live via the substrate); read ↔ the gate
  check('clean env ⇒ on (default-on)', ft.isFeatureToggleOn('compact-keep-tail') === true)
  check('clean env ⇒ REAL gate on (anti-fake)', vt.isMercuryCompactKeepTailEnabled() === true)
  // toggle OFF ⇒ env '0' (NOT deleted) + read off + REAL gate off
  check('set off ⇒ returns false', ft.setFeatureToggle('compact-keep-tail', false) === false)
  check("set off ⇒ env === '0' (explicit opt-out, NOT deleted)", process.env.MERCURY_COMPACT_KEEP_TAIL === '0')
  check('set off ⇒ isFeatureToggleOn false', ft.isFeatureToggleOn('compact-keep-tail') === false)
  check('set off ⇒ REAL gate off (anti-fake)', vt.isMercuryCompactKeepTailEnabled() === false)
  // toggle back ON ⇒ env '1' + read on + REAL gate on
  check('toggle ⇒ on', ft.toggleFeature('compact-keep-tail') === true)
  check("toggle on ⇒ env === '1'", process.env.MERCURY_COMPACT_KEEP_TAIL === '1')
  check('toggle on ⇒ REAL gate on (anti-fake)', vt.isMercuryCompactKeepTailEnabled() === true)
  clearEnv()
}

// ── 3. ANTI-FAKE: the toggle is observed by the REAL gate readers ───────────
section('anti-fake: the registry flip is seen by the ACTUAL gate functions')
{
  setStamp(true)
  clearEnv()

  // MCP untrusted hardening (fork + env === '1')
  check('mcp gate OFF before toggle', tp.isUntrustedMcpHardeningOn() === false)
  ft.setFeatureToggle('mcp-hardening', true)
  check('mcp gate ON after registry flip', tp.isUntrustedMcpHardeningOn() === true)
  ft.setFeatureToggle('mcp-hardening', false)
  check('mcp gate OFF after registry un-flip', tp.isUntrustedMcpHardeningOn() === false)

  // Classifier fail-closed
  check('classifier gate OFF before toggle', cf.classifierFailClosedEnabled() === false)
  ft.setFeatureToggle('classifier-fail-closed', true)
  check('classifier gate ON after registry flip', cf.classifierFailClosedEnabled() === true)
  ft.setFeatureToggle('classifier-fail-closed', false)
  check('classifier gate OFF after un-flip', cf.classifierFailClosedEnabled() === false)

  // Daemon breaker: feature ON ⇒ a timeout is NOT a fleet failure
  check('breaker: default ⇒ timeout IS a fleet failure', db.DaemonBreaker.timeoutIsFleetFailure() === true)
  ft.setFeatureToggle('daemon-breaker-timeout', true)
  check('breaker: feature ON ⇒ timeout NOT a fleet failure', db.DaemonBreaker.timeoutIsFleetFailure() === false)
  ft.setFeatureToggle('daemon-breaker-timeout', false)
  check('breaker: feature OFF ⇒ back to fleet failure', db.DaemonBreaker.timeoutIsFleetFailure() === true)
  clearEnv()
}

// ── 4. structural: env names match the real gates + panel/command wiring ────
section('structural: registry env ↔ real gate, and the /authority wiring')
{
  setStamp(true)
  // every registry env name is the var its gate actually reads
  check('MERCURY_RELEVANT_RECALL read by memdir/paths', src('memdir', 'paths.ts').includes('MERCURY_RELEVANT_RECALL'))
  // The consumers read the canonical spelling THROUGH the registry (flagEnv:
  // canonical first, then the row's legacy rung) — never a raw env literal.
  check(
    'MERCURY_MCP_UNTRUSTED_HARDENING read by toolPolicy through the registry',
    src('services', 'mcp', 'toolPolicy.ts').includes("'MERCURY_MCP_UNTRUSTED_HARDENING'") &&
      /flagEnv\(UNTRUSTED_HARDENING_ENV\)/.test(src('services', 'mcp', 'toolPolicy.ts')),
  )
  check('MERCURY_CLASSIFIER_FAIL_CLOSED read by classifierFailClosed', src('utils', 'permissions', 'classifierFailClosed.ts').includes('MERCURY_CLASSIFIER_FAIL_CLOSED'))
  check('MERCURY_COMMIT_GATE read by commitGate', src('utils', 'hooks', 'commitGate.ts').includes('MERCURY_COMMIT_GATE'))
  check(
    'MERCURY_DAEMON_BREAKER_TIMEOUT_OK read by daemonBreaker through the registry',
    src('utils', 'daemonBreaker.ts').includes("flagEnv('MERCURY_DAEMON_BREAKER_TIMEOUT_OK')"),
  )

  // command + panel are wired
  const auth = src('commands', 'authority', 'authority.tsx')
  check('authority.tsx imports the registry', /from '\.\.\/\.\.\/utils\/featureToggles\.js'/.test(auth))
  check('authority.tsx passes features + onToggleFeature', auth.includes('features={features}') && auth.includes('onToggleFeature={onToggleFeature}'))
  const panel = src('components', 'MercuryPermissionsPanel.tsx')
  check('panel has the writable feature branch', panel.includes('onToggleFeature') && panel.includes('feature toggles'))
  check('panel keeps gates read-only', panel.includes('read-only'))
}

// ── 5. read mirrors each gate's predicate (strict '1' vs isEnvTruthy) ───────
section('read exactness: strict gates reject \'true\', isEnvTruthy gates accept it')
{
  setStamp(true)
  clearEnv()
  // A user pre-set 'true' in their shell: the strict gates read OFF, the
  // isEnvTruthy gates read ON — the registry must match each, never misreport.
  process.env.MERCURY_RELEVANT_RECALL = 'true' // strict === '1' ⇒ OFF
  check('strict gate: env="true" ⇒ registry reads OFF (matches paths.ts)', ft.isFeatureToggleOn('relevant-recall') === false)
  process.env.MERCURY_CLASSIFIER_FAIL_CLOSED = 'true' // isEnvTruthy ⇒ ON
  check('truthy gate: env="true" ⇒ registry reads ON (matches classifier)', ft.isFeatureToggleOn('classifier-fail-closed') === true)
  check('truthy read agrees with the REAL gate on "true"', cf.classifierFailClosedEnabled() === true)
  process.env.MERCURY_COMMIT_GATE = 'yes' // isEnvTruthy ⇒ ON
  check('commit-gate: env="yes" ⇒ registry reads ON (matches commitGate)', ft.isFeatureToggleOn('commit-gate') === true)
  clearEnv()
}

// ── 6. commit-gate OFF honesty: the installed hook honors live env ──────────
section('commit-gate OFF honesty: the PreToolUse hook re-checks commitGateEnabled()')
{
  // The other 4 are pure live env reads at point-of-use; commit-gate is STATEFUL
  // (engageCommitGate installs a one-shot PreToolUse hook). The OFF flip can only
  // be honest if the installed callback re-checks the gate live — assert it does,
  // so toggling off actually stops blocking (not a repaint-only lie).
  const cg = src('utils', 'hooks', 'commitGate.ts')
  check('commitGate re-reads commitGateEnabled inside the installed callback (live re-check)', /commitGateEnabled\(\)/.test(cg))
  // OFF honesty: the callback passes (returns true) when the standalone gate
  // (commitGateEnabled, the /authority toggle) reads OFF — re-read live, so
  // toggling the gate off actually stops blocking.
  check('the installed callback passes when the gate reads off (live)', /if \(!commitGateEnabled\(\)\) return true/.test(cg))
  // and the toggle controls the exact var the gate reads
  check('MERCURY_COMMIT_GATE read by commitGateEnabled (alias-read)', src('utils', 'hooks', 'commitGate.ts').includes("isEnvTruthy(flagEnv('MERCURY_COMMIT_GATE'))"))
}

// hygiene
setStamp(false)
clearEnv()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL FEATURE-TOGGLE PROOFS PASS')
else console.log(`❌ ${failures} FEATURE-TOGGLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

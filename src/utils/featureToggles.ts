// featureToggles.ts — the runtime-toggleable fork feature registry behind
// /authority. Each capability reads its env var LIVE on every call (not folded
// at boot) — so flipping the env var mid-session genuinely changes behavior
// going forward. That is the precise reason a /authority toggle here is HONEST
// and not a lie: unlike the boot-time substrate gates (which the
// MercuryPermissionsPanel keeps read-only), these are re-read each call, so the
// switch takes effect without a restart.
//
// Two flavours, both honest:
//   • DEFAULT-OFF opt-ins (the original five): ON ⇒ env `'1'`, OFF ⇒ delete env
//     (reads the default-off). set-on === '1' / set-off === delete is exact.
//   • DEFAULT-ON capabilities (`defaultOn`, e.g. autocompact keep-tail): ON ⇒ env
//     `'1'`, OFF ⇒ env `'0'` (the explicit opt-out the gate honors) — NOT delete,
//     since deleting would read back as the default ON. Such a def carries a
//     `read` fn that calls the REAL gate, so the panel can never drift from what
//     the gate actually does (the on-clean-env state IS the gate's default).
// The READ side mirrors each gate precisely: strict `=== '1'` by default,
// isEnvTruthy where the gate uses it (also 'true'/'yes'/'on'), or the gate's own
// predicate via `read` — so a pre-set shell value is never misreported.
import { deleteFlagEnv, flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { isMercuryCompactKeepTailEnabled } from '../services/compact/verbatimTail.js'
import { isEnvTruthy } from './envUtils.js'
import { isAwaySummaryEnabled } from './cockpit/awaySummary.js'

/** One runtime-toggleable feature, resolved to its live on/off state. */
export type FeatureToggle = {
  /** Stable id (used by the panel + setters). */
  key: string
  /** Short display label. */
  label: string
  /** The env var it controls. */
  env: string
  /** Live state — read at call time (`env === '1'`). */
  on: boolean
  /** Honest note on WHEN a flip takes effect (some scopes aren't instant). */
  scope: string
  /** A behavior-changer that could break a working flow — render with caution. */
  caution?: boolean
  /** This capability is ON by default (Mercury ships it live). OFF ⇒ env `'0'`. */
  defaultOn?: boolean
}

// `truthy` mirrors how the REAL gate reads its env: strict `=== '1'` by default,
// or isEnvTruthy (also 'true'/'yes'/'on') when the gate uses it — so the panel's
// on/off never disagrees with what the gate actually does. `read` (for default-on
// capabilities) defers to the gate's own predicate, the strongest no-drift form.
type ToggleDef = Omit<FeatureToggle, 'on'> & {
  truthy?: boolean
  read?: () => boolean
}

// The five DEFAULT-OFF features. Order = render order.
const TOGGLE_DEFS: ToggleDef[] = [
  {
    key: 'relevant-recall',
    label: 'Relevance memory recall',
    env: 'MERCURY_RELEVANT_RECALL',
    scope: 'applies to the next turn',
  },
  {
    key: 'mcp-hardening',
    label: 'MCP untrusted hardening',
    env: 'MERCURY_MCP_UNTRUSTED_HARDENING',
    scope: 'changes MCP tools mid-session',
    caution: true,
  },
  {
    key: 'classifier-fail-closed',
    label: 'Classifier fail-closed',
    env: 'MERCURY_CLASSIFIER_FAIL_CLOSED',
    scope: 'stricter tool gating, live',
    caution: true,
    truthy: true, // classifierFailClosed.ts reads via isEnvTruthy
  },
  {
    key: 'commit-gate',
    label: 'Build-gate && commits',
    env: 'MERCURY_COMMIT_GATE',
    // ON engages on the next query; OFF takes effect live (the hook re-checks
    // commitGateEnabled() each call) — honest as "next turn" for the slower edge.
    scope: 'git commits · next turn',
    truthy: true, // commitGate.commitGateEnabled reads via isEnvTruthy
  },
  {
    key: 'daemon-breaker-timeout',
    label: 'Daemon breaker: timeout OK',
    env: 'MERCURY_DAEMON_BREAKER_TIMEOUT_OK',
    // Honest: this gate is read in the DAEMON subprocess, not the REPL. Setting
    // it here only reaches daemons spawned AFTER the flip (they inherit env).
    scope: 'daemons started after the flip',
  },
  {
    // DEFAULT-ON: Mercury ships verbatim recent-tail preservation across full
    // autocompact live. Toggle here to A/B it on a long run or kill it instantly
    // if it ever misbehaves — the gate re-reads env each compaction, and `read`
    // defers to the real gate so the panel shows the true (default-on) state.
    key: 'compact-keep-tail',
    label: 'Autocompact: keep recent tail',
    env: 'MERCURY_COMPACT_KEEP_TAIL',
    scope: 'applies to the next compaction',
    defaultOn: true,
    read: () => isMercuryCompactKeepTailEnabled(),
  },
  {
    // DEFAULT-ON: the resume "what happened while you were gone" recap. Toggle to
    // silence it or re-enable; `read` defers to the real gate (no drift).
    key: 'away-summary',
    label: 'Resume: away debrief',
    env: 'MERCURY_AWAY_SUMMARY',
    scope: 'applies to the next resume',
    defaultOn: true,
    read: () => isAwaySummaryEnabled(),
  },
]

/** Live state mirroring the gate's own predicate (its `read` fn, else strict '1' vs isEnvTruthy). */
function isOn(def: ToggleDef): boolean {
  if (def.read) return def.read()
  return def.truthy ? isEnvTruthy(flagEnv(def.env)) : flagEnv(def.env) === '1'
}

/** The toggleable features with live state. */
export function listFeatureToggles(): FeatureToggle[] {
  
  return TOGGLE_DEFS.map(d => ({ key: d.key, label: d.label, env: d.env, scope: d.scope, caution: d.caution, on: isOn(d) }))
}

/** Live on/off for one feature by key (false if unknown). */
export function isFeatureToggleOn(key: string): boolean {
  
  const def = TOGGLE_DEFS.find(d => d.key === key)
  return def ? isOn(def) : false
}

/**
 * Set a feature on/off by writing its env var in-process. ON ⇒ '1' (satisfies
 * both the strict `=== '1'` gates and the isEnvTruthy ones); OFF ⇒ delete (so
 * every gate reads its DEFAULT-OFF). Returns the resulting state, or false if
 * unknown key (no-op). Session-scoped — to persist, set the env var
 * in your shell / settings.
 */
export function setFeatureToggle(key: string, on: boolean): boolean {
  
  const def = TOGGLE_DEFS.find(d => d.key === key)
  if (!def) return false
  if (on) setFlagEnv(def.env, '1')
  // DEFAULT-ON capabilities need an explicit `'0'` opt-out — deleting would read
  // back as their default ON. DEFAULT-OFF ones delete to read their default off.
  else if (def.defaultOn) setFlagEnv(def.env, '0')
  else deleteFlagEnv(def.env)
  return on
}

/** Flip one feature and return its new live state. */
export function toggleFeature(key: string): boolean {
  return setFeatureToggle(key, !isFeatureToggleOn(key))
}

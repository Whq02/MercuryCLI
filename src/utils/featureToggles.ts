import { deleteFlagEnv, flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { isMercuryCompactKeepTailEnabled } from '../services/compact/verbatimTail.js'
import { isEnvTruthy } from './envUtils.js'
import { isAwaySummaryEnabled } from './cockpit/awaySummary.js'

export type FeatureToggle = {
  key: string
  label: string
  env: string
  on: boolean
  scope: string
  caution?: boolean
  defaultOn?: boolean
}

type ToggleDef = Omit<FeatureToggle, 'on'> & {
  truthy?: boolean
  read?: () => boolean
}

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
    truthy: true,
  },
  {
    key: 'commit-gate',
    label: 'Build-gate && commits',
    env: 'MERCURY_COMMIT_GATE',
    scope: 'git commits · next turn',
    truthy: true,
  },
  {
    key: 'daemon-breaker-timeout',
    label: 'Daemon breaker: timeout OK',
    env: 'MERCURY_DAEMON_BREAKER_TIMEOUT_OK',
    scope: 'daemons started after the flip',
  },
  {
    key: 'compact-keep-tail',
    label: 'Autocompact: keep recent tail',
    env: 'MERCURY_COMPACT_KEEP_TAIL',
    scope: 'applies to the next compaction',
    defaultOn: true,
    read: () => isMercuryCompactKeepTailEnabled(),
  },
  {
    key: 'away-summary',
    label: 'Resume: away debrief',
    env: 'MERCURY_AWAY_SUMMARY',
    scope: 'applies to the next resume',
    defaultOn: true,
    read: () => isAwaySummaryEnabled(),
  },
]

function isOn(def: ToggleDef): boolean {
  if (def.read) return def.read()
  return def.truthy ? isEnvTruthy(flagEnv(def.env)) : flagEnv(def.env) === '1'
}

export function listFeatureToggles(): FeatureToggle[] {
  
  return TOGGLE_DEFS.map(d => ({ key: d.key, label: d.label, env: d.env, scope: d.scope, caution: d.caution, on: isOn(d) }))
}

export function isFeatureToggleOn(key: string): boolean {
  
  const def = TOGGLE_DEFS.find(d => d.key === key)
  return def ? isOn(def) : false
}

export function setFeatureToggle(key: string, on: boolean): boolean {
  
  const def = TOGGLE_DEFS.find(d => d.key === key)
  if (!def) return false
  if (on) setFlagEnv(def.env, '1')
  else if (def.defaultOn) setFlagEnv(def.env, '0')
  else deleteFlagEnv(def.env)
  return on
}

export function toggleFeature(key: string): boolean {
  return setFeatureToggle(key, !isFeatureToggleOn(key))
}

import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'
import { JEV_SUBAGENT_CALL_BUDGET, jevUsdLabel } from './jevContract.js'

export interface JevSettings {
  enabled: boolean
  allowanceUsd: number
  pacePerMinute: number
  requestCeiling: number | null
  subagents: boolean
}

export const JEV_DEFAULT_ALLOWANCE_USD = 20
export const JEV_DEFAULT_PACE_PER_MINUTE = 10

export const JEV_DEFAULT_SETTINGS: Readonly<JevSettings> = Object.freeze({
  enabled: false,
  allowanceUsd: JEV_DEFAULT_ALLOWANCE_USD,
  pacePerMinute: JEV_DEFAULT_PACE_PER_MINUTE,
  requestCeiling: null,
  subagents: false,
})

type StoredJev = NonNullable<ReturnType<typeof getGlobalConfig>['jev']>

function positiveMoney(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

export function jevSettingsFromStored(stored: StoredJev | undefined): JevSettings {
  return {
    enabled: stored?.enabled === true,
    allowanceUsd: positiveMoney(stored?.allowanceUsd) ?? JEV_DEFAULT_ALLOWANCE_USD,
    pacePerMinute: positiveCount(stored?.pacePerMinute) ?? JEV_DEFAULT_PACE_PER_MINUTE,
    requestCeiling: positiveCount(stored?.requestCeiling) ?? null,
    subagents: stored?.subagents === true,
  }
}

export function readJevSettings(): JevSettings {
  if (!isConfigReadingAllowed()) return { ...JEV_DEFAULT_SETTINGS }
  return jevSettingsFromStored(getGlobalConfig().jev)
}

export function jevEnabled(): boolean {
  return readJevSettings().enabled
}

function writeJev(mutate: (stored: StoredJev) => StoredJev): JevSettings {
  let out: JevSettings = { ...JEV_DEFAULT_SETTINGS }
  saveGlobalConfig(config => {
    const next = mutate({ ...(config.jev ?? {}) })
    const trimmed: StoredJev = {}
    if (next.enabled === true) trimmed.enabled = true
    if (positiveMoney(next.allowanceUsd) !== undefined && next.allowanceUsd !== JEV_DEFAULT_ALLOWANCE_USD) trimmed.allowanceUsd = next.allowanceUsd
    if (positiveCount(next.pacePerMinute) !== undefined && next.pacePerMinute !== JEV_DEFAULT_PACE_PER_MINUTE) trimmed.pacePerMinute = next.pacePerMinute
    if (positiveCount(next.requestCeiling) !== undefined) trimmed.requestCeiling = next.requestCeiling
    if (next.subagents === true) trimmed.subagents = true
    out = jevSettingsFromStored(trimmed)
    const rest = { ...config }
    if (Object.keys(trimmed).length === 0) delete rest.jev
    else rest.jev = trimmed
    return rest
  })
  return out
}

export function setJevEnabled(next: boolean): JevSettings {
  return writeJev(stored => ({ ...stored, enabled: next }))
}

export function setJevAllowanceUsd(next: number): JevSettings {
  const value = positiveMoney(next)
  if (value === undefined) throw new Error(`the JEV session allowance is a positive dollar amount, not ${String(next)}`)
  return writeJev(stored => ({ ...stored, allowanceUsd: value }))
}

export function setJevPacePerMinute(next: number): JevSettings {
  const value = positiveCount(next)
  if (value === undefined) throw new Error(`the JEV pace is a whole number of requests a minute (1 or more), not ${String(next)}`)
  return writeJev(stored => ({ ...stored, pacePerMinute: value }))
}

export function setJevRequestCeiling(next: number | null): JevSettings {
  if (next === null) {
    return writeJev(stored => {
      const rest = { ...stored }
      delete rest.requestCeiling
      return rest
    })
  }
  const value = positiveCount(next)
  if (value === undefined) throw new Error(`the JEV request ceiling is a whole number of requests (1 or more) or off, not ${String(next)}`)
  return writeJev(stored => ({ ...stored, requestCeiling: value }))
}

export function setJevSubagents(next: boolean): JevSettings {
  return writeJev(stored => ({ ...stored, subagents: next }))
}

export const JEV_DOORS = '/jev, the JEV row of /config, or the JEV row of the Boot Menu (one switch)'

export function jevValueWords(settings: JevSettings = readJevSettings()): string {
  return settings.enabled ? 'on' : 'off'
}

export function jevReceiptWords(settings: JevSettings): string {
  return settings.enabled
    ? 'JEV on — JevEval joins the roster at the next turn boundary once a key is stored'
    : 'JEV off — JevEval leaves the roster at the next turn boundary; nothing is sent'
}

export function jevCeilingWords(settings: JevSettings): string {
  return settings.requestCeiling === null ? 'off' : `${settings.requestCeiling} requests a session`
}

export function jevSettingLines(settings: JevSettings = readJevSettings()): string[] {
  return [
    `session allowance: ${jevUsdLabel(settings.allowanceUsd)} — a runaway stop, not a budget; Mercury's own count, reset by /clear`,
    `pace: ${settings.pacePerMinute} requests a minute`,
    `request ceiling: ${jevCeilingWords(settings)}`,
    `sub-agents: ${settings.subagents ? `on — ${JEV_SUBAGENT_CALL_BUDGET} calls each, on the same allowance` : 'off'}`,
    `doors: ${JEV_DOORS}`,
  ]
}

export const JEV_MENU_ROW = {
  env: 'jev',
  label: 'JEV',
  group: 'agents',
  kind: 'toggle',
  options: ['on'],
  defaultLabel: 'off',
  applicationClass: 'live',
  summary:
    "a second opinion for the main model — TypeSafe's Jev answers typed questions (yes/no, choice, score) with numbers, never an approval; off by default; needs the key you paste in /jev",
  detail: {
    controls:
      'Whether the JevEval tool is in the roster. On, with a key stored through /jev, the main model can rank hypotheses, make a qualitative call after the frames are measured, or check a proposal against your recorded rulings. It never answers a permission request. Applies at the next turn boundary.',
    on: [
      'JevEval is offered to the main model; each call is one batched request, counted on the session allowance shown in /jev and /usage',
      'the allowance ($20 by default) is a runaway stop; the pace (10 a minute) and the optional request ceiling do the real work',
      'no key stored ⇒ the tool is absent and /jev says no key; nothing is sent',
    ],
    off: ['JevEval is not in the roster; no request leaves the machine; nothing about permissions changes either way'],
  },
} as const

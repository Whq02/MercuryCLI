import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'
import { JEV_SUBAGENT_CALL_BUDGET, JEV_SUBAGENT_PACE_PER_MINUTE, type JevRoad, jevRoadWords, jevUsdLabel } from './jevContract.js'

export interface JevSettings {
  enabled: boolean
  road: JevRoad
  allowanceUsd: number
  pacePerMinute: number
  requestCeiling: number | null
  subagents: boolean
}

export const JEV_DEFAULT_ALLOWANCE_USD = 20
export const JEV_DEFAULT_PACE_PER_MINUTE = 100

export const JEV_DEFAULT_SETTINGS: Readonly<JevSettings> = Object.freeze({
  enabled: false,
  road: 'official',
  allowanceUsd: JEV_DEFAULT_ALLOWANCE_USD,
  pacePerMinute: JEV_DEFAULT_PACE_PER_MINUTE,
  requestCeiling: null,
  subagents: true,
})

type StoredJev = NonNullable<ReturnType<typeof getGlobalConfig>['jev']>

function positiveMoney(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

export function jevSettingsFromStored(stored: StoredJev | undefined): JevSettings {
  const road = stored?.road === 'openrouter' ? 'openrouter' : 'official'
  return {
    enabled: stored?.enabled === true,
    road,
    allowanceUsd: positiveMoney(road === 'openrouter' ? stored?.openrouterAllowanceUsd : stored?.allowanceUsd) ?? JEV_DEFAULT_ALLOWANCE_USD,
    pacePerMinute: positiveCount(stored?.pacePerMinute) ?? JEV_DEFAULT_PACE_PER_MINUTE,
    requestCeiling: positiveCount(stored?.requestCeiling) ?? null,
    subagents: stored?.subagents !== false,
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
    if (next.road === 'openrouter') trimmed.road = next.road
    if (positiveMoney(next.allowanceUsd) !== undefined && next.allowanceUsd !== JEV_DEFAULT_ALLOWANCE_USD) trimmed.allowanceUsd = next.allowanceUsd
    if (positiveMoney(next.openrouterAllowanceUsd) !== undefined && next.openrouterAllowanceUsd !== JEV_DEFAULT_ALLOWANCE_USD) trimmed.openrouterAllowanceUsd = next.openrouterAllowanceUsd
    if (positiveCount(next.pacePerMinute) !== undefined && next.pacePerMinute !== JEV_DEFAULT_PACE_PER_MINUTE) trimmed.pacePerMinute = next.pacePerMinute
    if (positiveCount(next.requestCeiling) !== undefined) trimmed.requestCeiling = next.requestCeiling
    if (next.subagents === false) trimmed.subagents = false
    out = jevSettingsFromStored(trimmed)
    const rest = { ...config }
    if (Object.keys(trimmed).length === 0) delete rest.jev
    else rest.jev = trimmed
    return rest
  })
  return out
}

export function setJevEnabled(next: boolean, road?: JevRoad): JevSettings {
  return writeJev(stored => ({ ...stored, enabled: next, ...(road === undefined ? {} : { road }) }))
}

export function setJevRoad(road: JevRoad): JevSettings {
  return writeJev(stored => ({ ...stored, road }))
}

export function setJevAllowanceUsd(next: number): JevSettings {
  const value = positiveMoney(next)
  if (value === undefined) throw new Error(`the JEV session allowance is a positive dollar amount, not ${String(next)}`)
  return writeJev(stored => ({ ...stored, [stored.road === 'openrouter' ? 'openrouterAllowanceUsd' : 'allowanceUsd']: value }))
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
  return `${settings.enabled ? 'on' : 'off'} · ${jevRoadWords(settings.road)}`
}

export function jevReceiptWords(settings: JevSettings): string {
  return settings.enabled
    ? `JEV on — ${jevRoadWords(settings.road)}; JevEval joins the roster next turn with this road's key`
    : `JEV off — ${jevRoadWords(settings.road)} saved; nothing is sent; JevEval leaves the roster next turn`
}

export function jevCeilingWords(settings: JevSettings): string {
  return settings.requestCeiling === null ? 'off' : `${settings.requestCeiling} requests a session`
}

export function jevSettingLines(settings: JevSettings = readJevSettings()): string[] {
  return [
    `session allowance: ${jevUsdLabel(settings.allowanceUsd)} — a runaway stop, not a budget; ${jevRoadWords(settings.road)} road only, reset by /clear`,
    `pace: ${settings.pacePerMinute} requests a minute`,
    `request ceiling: ${jevCeilingWords(settings)}`,
    `sub-agents: ${settings.subagents ? `on — ${JEV_SUBAGENT_CALL_BUDGET} calls each; ${JEV_SUBAGENT_PACE_PER_MINUTE} a minute per session, on the same allowance` : 'off'}`,
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
    "a second opinion from TypeSafe's Jev, never an approval; JEV off by default; once on, sub-agents get it by default, off by choice; /jev chooses official or OpenRouter, each with its own key, spend and cap",
  detail: {
    controls:
      'Whether JevEval is in the roster on the road saved in /jev. Official needs a TypeSafe key in /jev; OpenRouter uses its sign-in from /logins. It never answers a permission request. Applies at the next turn boundary.',
    on: [
      'JevEval is offered to the main model; each call is one batched request, counted on the selected road in /jev and /usage',
      `each road has its own allowance ($20 by default), a runaway stop; the main pace (${JEV_DEFAULT_PACE_PER_MINUTE} a minute by default) and optional request ceiling also apply`,
      'no key for the selected road ⇒ the tool is absent; no fallback and nothing sent; sign-in alone never switches JEV on',
    ],
    off: ['JevEval is not in the roster; no request leaves the machine; nothing about permissions changes either way'],
  },
} as const

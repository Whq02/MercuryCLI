import { type JevStatus, type JevStatusKind, jevClockLabel, jevRefusalNamesCredit, jevWaitLabel } from './jevContract.js'
import { type JevKeyPresence, jevKeyPresence } from './jevKey.js'
import { type JevLedgerSnapshot, jevAdmission, jevLedgerSnapshot } from './jevLedger.js'
import { type JevSettings, readJevSettings } from './jevSetting.js'

export interface JevAgentIdentity {
  id: string
  subagent: boolean
}

export interface JevStatusInputs {
  settings: JevSettings
  key: JevKeyPresence
  ledger: JevLedgerSnapshot
  now: number
  agent?: JevAgentIdentity
}

export const JEV_STATUS_HEADWORDS: Readonly<Record<JevStatusKind, string>> = Object.freeze({
  ready: 'ready',
  off: 'off',
  'no-key': 'no key',
  'invalid-key': 'invalid key',
  'allowance-hit': 'allowance hit',
  'pace-hit': 'pace hit',
  'ceiling-hit': 'request ceiling hit',
  'subagent-budget-hit': 'sub-agent budget hit',
  'rate-limited': 'rate limited by the provider',
  'provider-down': 'provider down',
  'provider-credit': 'provider refused for credit',
  'provider-refused': 'provider refused',
})

export function jevStatusIsFinalForSession(kind: JevStatusKind): boolean {
  return kind === 'off' || kind === 'no-key' || kind === 'invalid-key' || kind === 'allowance-hit' || kind === 'ceiling-hit' || kind === 'subagent-budget-hit' || kind === 'provider-credit'
}

function quoted(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim()
  const clipped = flat.length > 160 ? `${flat.slice(0, 157)}...` : flat
  return JSON.stringify(clipped)
}

export function resolveJevStatus(inputs: JevStatusInputs): JevStatus {
  const { settings, key, ledger, now, agent } = inputs
  if (!settings.enabled) return { kind: 'off', words: 'off — the JEV switch is off; /jev, the JEV row of /config or the JEV row of the Boot Menu turns it on' }
  if (agent?.subagent === true && !settings.subagents) return { kind: 'off', words: 'off — JEV is not offered to sub-agents until the sub-agents setting in /jev is on' }
  if (!key.present) return { kind: 'no-key', words: 'no key — no TypeSafe API key is stored; paste one in /jev (Mercury ships none)' }
  const wire = ledger.lastWire
  if (wire?.kind === 'invalid-key') {
    return {
      kind: 'invalid-key',
      words: `invalid key — the provider answered ${wire.status ?? 401} at ${jevClockLabel(wire.at)}; replace the key in /jev`,
    }
  }
  const admission = jevAdmission(settings, now, agent?.subagent === true ? agent.id : undefined)
  if (!admission.ok) return { kind: admission.kind, words: admission.words, retryInMs: admission.retryInMs }
  if (wire !== null && ledger.holdUntil > now) {
    const retryInMs = ledger.holdUntil - now
    const at = jevClockLabel(wire.at)
    const next = `the next attempt is admitted in ${jevWaitLabel(retryInMs)}`
    if (wire.kind === 'rate-limited') {
      const wait = wire.retryAfterMs !== undefined ? `it asked for ${jevWaitLabel(wire.retryAfterMs)}` : 'it named no wait'
      return { kind: 'rate-limited', words: `rate limited by the provider — 429 at ${at}, ${wait}; ${next}`, retryInMs }
    }
    if (wire.kind === 'provider-down' || wire.kind === 'parse-failed') {
      const what = wire.kind === 'parse-failed' ? `an answer Mercury could not read (${quoted(wire.detail)})` : `${wire.status !== undefined ? `${wire.status} ` : ''}${quoted(wire.detail)}`
      return { kind: 'provider-down', words: `provider down — ${what} at ${at}; ${next}`, retryInMs }
    }
    if (wire.kind === 'provider-refused') {
      if (jevRefusalNamesCredit(wire.detail)) {
        return { kind: 'provider-credit', words: `provider refused for credit — it said ${quoted(wire.detail)} (${wire.status ?? 'no status'}) at ${at}; top up at the provider, then /clear or a new key admits the next attempt`, retryInMs }
      }
      return { kind: 'provider-refused', words: `provider refused — ${wire.status ?? 'no status'} ${quoted(wire.detail)} at ${at}; ${next}`, retryInMs }
    }
  }
  return { kind: 'ready', words: 'ready' }
}

export function jevStatus(agent?: JevAgentIdentity, now: number = Date.now()): JevStatus {
  return resolveJevStatus({ settings: readJevSettings(), key: jevKeyPresence(), ledger: jevLedgerSnapshot(now), now, agent })
}

export function jevStatusLine(status: JevStatus = jevStatus()): string {
  return `JEV ${status.words}`
}

import type { CallModelRoute } from '../../services/providers/routeLaw.js'
import type { ModelOption } from './modelOptions.js'
import { catalogueEpoch } from '../../services/providers/catalogueEpoch.js'
import { readSignInLedger, signInLedgerEpoch, type SignInKind } from '../accounts/signInLedger.js'

export type ComputedDefaultSource = 'sign-in' | 'fallthrough' | 'keyless'

export const NO_SIGN_IN_ROW = 'no sign-in yet'
export const NO_SIGN_IN_REASON = 'no sign-in yet — /logins signs a provider in'
export const NO_USABLE_ROW = 'no usable row yet'

export interface CredentialFact {
  family: string
  at: number | null
  kind?: SignInKind
  label?: string
}

export type LaneRowVerdict =
  | { usable: true; setting: string; row: string; why: string }
  | { usable: false; why: string }

export interface KeylessFact {
  setting: string
  why: string
}

export interface ComputedDefaultFacts {
  credentials: CredentialFact[]
  recordedDefaultProvider?: string
  registryOrder: readonly string[]
  laneRow: (family: string) => LaneRowVerdict
  keyless: KeylessFact
  providerName?: (family: string) => string
  formatTime?: (ms: number) => string
}

export interface ConsideredCredential extends CredentialFact {
  timed: boolean
  recency: string
  verdict: LaneRowVerdict
}

export interface ComputedDefault {
  setting: string
  row: string
  provider: string | null
  source: ComputedDefaultSource
  chosen: ConsideredCredential | null
  considered: ConsideredCredential[]
  why: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatSignInTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

const KIND_WORDS: Record<SignInKind, string> = {
  oauth: 'OAuth sign-in',
  subscription: 'subscription sign-in',
  'api-key': 'API key',
  'operator-switch': '/defaultprovider switch',
}

export function orderCredentials(
  facts: Pick<ComputedDefaultFacts, 'credentials' | 'recordedDefaultProvider' | 'registryOrder'>,
): CredentialFact[] {
  const rank = (family: string): number => {
    const index = facts.registryOrder.indexOf(family)
    return index === -1 ? facts.registryOrder.length : index
  }
  const timed = facts.credentials
    .filter(c => c.at !== null)
    .sort((a, b) => (b.at as number) - (a.at as number) || rank(a.family) - rank(b.family) || a.family.localeCompare(b.family))
  const recorded = facts.recordedDefaultProvider
  const untimedRank = (family: string): number => (family === recorded ? -1 : rank(family))
  const untimed = facts.credentials
    .filter(c => c.at === null)
    .sort((a, b) => untimedRank(a.family) - untimedRank(b.family) || a.family.localeCompare(b.family))
  return [...timed, ...untimed]
}

function recencyWords(credential: CredentialFact, index: number, facts: ComputedDefaultFacts): string {
  const format = facts.formatTime ?? formatSignInTime
  if (credential.at !== null) {
    const kind = credential.kind !== undefined ? `${KIND_WORDS[credential.kind]}, ` : ''
    return `${index === 0 ? 'the most recent sign-in' : 'an earlier sign-in'} (${kind}${format(credential.at)})`
  }
  const recorded = credential.family === facts.recordedDefaultProvider ? 'the recorded default provider, ' : ''
  const label = credential.label !== undefined ? ` (${credential.label})` : ''
  return `${recorded}sign-in time not recorded${label}`
}

export function evaluateComputedDefault(facts: ComputedDefaultFacts): ComputedDefault {
  const name = facts.providerName ?? ((family: string): string => family)
  const considered: ConsideredCredential[] = orderCredentials(facts).map((credential, index) => ({
    ...credential,
    timed: credential.at !== null,
    recency: recencyWords(credential, index, facts),
    verdict: facts.laneRow(credential.family),
  }))
  const chosenIndex = considered.findIndex(c => c.verdict.usable)
  if (chosenIndex === -1) {
    const why =
      considered.length === 0
        ? facts.keyless.why
        : `no sign-in offers a usable row (${considered
            .map(c => `${name(c.family)}: ${c.verdict.why}`)
            .join('; ')}) — /logins signs another provider in`
    return {
      setting: facts.keyless.setting,
      row: considered.length === 0 ? NO_SIGN_IN_ROW : NO_USABLE_ROW,
      provider: null,
      source: 'keyless',
      chosen: null,
      considered,
      why,
    }
  }
  const chosen = considered[chosenIndex] as ConsideredCredential
  const verdict = chosen.verdict as Extract<LaneRowVerdict, { usable: true }>
  const source: ComputedDefaultSource = chosenIndex === 0 ? 'sign-in' : 'fallthrough'
  const lead = `${verdict.row} — ${name(chosen.family)}, ${chosen.recency}; ${verdict.why}`
  const skipped = considered
    .slice(0, chosenIndex)
    .map(c => `${name(c.family)} (${c.recency}) — ${c.verdict.why}`)
    .join('; ')
  return {
    setting: verdict.setting,
    row: verdict.row,
    provider: chosen.family,
    source,
    chosen,
    considered,
    why: source === 'sign-in' ? lead : `${lead}. Skipped: ${skipped}`,
  }
}

function sourceWords(decision: ComputedDefault): string {
  switch (decision.source) {
    case 'sign-in':
      return decision.chosen?.timed
        ? 'the most recent sign-in'
        : decision.chosen?.recency.startsWith('the recorded default provider')
          ? 'the recorded default provider'
          : 'a sign-in with no recorded time'
    case 'fallthrough':
      return 'the most recent sign-in with a usable row'
    case 'keyless':
      return NO_SIGN_IN_ROW
  }
}

const identity = (family: string): string => family

export function keylessReason(decision: Pick<ComputedDefault, 'considered' | 'why'>): string {
  return decision.considered.length === 0 ? NO_SIGN_IN_REASON : decision.why
}

export function describeComputedDefaultRow(
  decision: ComputedDefault,
  providerName: (family: string) => string = identity,
): string {
  if (decision.source === 'keyless' || decision.provider === null) return `Default (${keylessReason(decision)})`
  return `Default (${decision.row} — ${providerName(decision.provider)}, ${sourceWords(decision)})`
}

export function describeComputedDefaultLabel(
  decision: ComputedDefault,
  providerName: (family: string) => string = identity,
): string {
  if (decision.source === 'keyless' || decision.provider === null) {
    return decision.considered.length === 0
      ? `${NO_SIGN_IN_ROW} (default — /logins signs a provider in)`
      : `${NO_USABLE_ROW} (default — ${decision.why})`
  }
  return `${decision.row} (default — ${providerName(decision.provider)}, ${sourceWords(decision)})`
}

export function describeComputedDefault(
  decision: ComputedDefault,
  providerName: (family: string) => string = identity,
): string {
  if (decision.chosen === null || decision.provider === null) {
    return `${decision.row} · ${decision.why}`
  }
  return `${decision.row} · ${providerName(decision.provider)} · ${decision.chosen.recency} · ${decision.chosen.verdict.why}`
}


const FIRST_PARTY_EVIDENCE: Record<string, string> = {
  'eligible-env-pin': 'the ANTHROPIC_DEFAULT_FABLE_MODEL pin names it',
  'eligible-allowlist': 'the model allowlist names it',
  'eligible-max-20x': 'a confirmed Max 20x subscription',
}

const FIRST_PARTY_GATE: Record<string, string> = {
  'not-subscriber': 'a Claude subscription at the confirmed Max 20x tier (this credential is not a subscription)',
  'not-max': 'a Max subscription at the confirmed 20x tier',
  'unknown-rate-limit-tier': "a confirmed Max 20x tier (this subscription's tier is not known yet)",
  'not-20x': 'the Max 20x tier',
  'allowlist-excluded': 'a place on the model allowlist',
  'no-registered-candidate': 'a registered frontier row',
}

function liveFirstPartyRow(): LaneRowVerdict {
  const { frontierOperatorDecision } =
    require('./frontierPolicy.js') as typeof import('./frontierPolicy.js')
  const { renderModelName } = require('./model.js') as typeof import('./model.js')
  const decision = frontierOperatorDecision()
  const row = renderModelName(decision.setting)
  if (decision.source === 'frontier') {
    const evidence = FIRST_PARTY_EVIDENCE[decision.code] ?? decision.code
    return { usable: true, setting: decision.setting, row, why: `the newest row this sign-in can use (${evidence})` }
  }
  const leading = decision.candidates[0]
  const gated = leading !== undefined ? renderModelName(leading.id) : 'the frontier row'
  const gate = FIRST_PARTY_GATE[decision.code] ?? decision.code
  return {
    usable: true,
    setting: decision.setting,
    row,
    why: `${gated} needs ${gate}; ${row} is the newest row this sign-in can use`,
  }
}

const KEY_LANES = new Set(['zai', 'moonshot', 'deepseek'])

function keyLaneRow(family: 'zai' | 'moonshot' | 'deepseek'): LaneRowVerdict {
  try {
    const { keyLanePins } = require('./modelOptions.js') as typeof import('./modelOptions.js')
    const pin = keyLanePins(family)[0]
    if (pin === undefined) return { usable: false, why: 'no row in the pin table yet' }
    return {
      usable: true,
      setting: pin.id,
      row: pin.displayName,
      why: `the newest row this sign-in can use (the recorded frontier, ${pin.observedAt})`,
    }
  } catch {
    return { usable: false, why: 'the pin table could not be read' }
  }
}

let walkingPicker = false

function livePickerRows(): ModelOption[] | null {
  if (walkingPicker) return null
  walkingPicker = true
  try {
    const { getModelOptions } = require('./modelOptions.js') as typeof import('./modelOptions.js')
    return getModelOptions()
  } catch {
    return null
  } finally {
    walkingPicker = false
  }
}

function pickerRowFor(family: string, rows: ModelOption[] | null): LaneRowVerdict {
  if (rows === null) return { usable: false, why: 'the catalogue is being composed' }
  try {
    const { isProviderActionRow } = require('./modelOptions.js') as typeof import('./modelOptions.js')
    const { declaredRouteOf } =
      require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
    const { providerFrontierFact } =
      require('./providerFrontier.js') as typeof import('./providerFrontier.js')
    const { normalizeModelStringForAPI } = require('./model.js') as typeof import('./model.js')
    const familyRows = rows.filter(
      option =>
        typeof option.value === 'string' &&
        !option.value.startsWith('__') &&
        !isProviderActionRow(option.value) &&
        declaredRouteOf(option.value) === family,
    )
    const selectable = familyRows.filter(option => option.unavailable === undefined)
    if (selectable.length === 0) {
      const first = familyRows[0]
      return {
        usable: false,
        why:
          first !== undefined && first.unavailable !== undefined
            ? `${first.label}: ${first.unavailable}`
            : 'no selectable row in the catalogue yet',
      }
    }
    const fact = providerFrontierFact(family as CallModelRoute)
    const sameId = (value: string, id: string): boolean =>
      normalizeModelStringForAPI(value).toLowerCase() === normalizeModelStringForAPI(id).toLowerCase()
    const preferred =
      fact !== undefined ? selectable.find(option => sameId(option.value as string, fact.modelId)) : undefined
    const pick = preferred ?? (selectable[0] as (typeof selectable)[number])
    const why =
      preferred !== undefined && fact !== undefined
        ? `the newest row this sign-in can use (the recorded frontier${fact.observedAt !== undefined ? `, ${fact.observedAt}` : ''})`
        : "the first row this sign-in can use (the catalogue's own order)"
    return { usable: true, setting: pick.value as string, row: pick.label, why }
  } catch {
    return { usable: false, why: 'the catalogue could not be read' }
  }
}

function liveKeyless(): KeylessFact {
  const { frontierOperatorDecision } =
    require('./frontierPolicy.js') as typeof import('./frontierPolicy.js')
  return {
    setting: frontierOperatorDecision().setting,
    why: 'no provider is signed in yet — /logins signs one in, and its newest usable row becomes the default',
  }
}

export function recentSignIns(): CredentialFact[] {
  const { providerFamilyPresences } =
    require('../../services/providers/providerUsage.js') as typeof import('../../services/providers/providerUsage.js')
  const { buildRouterModelSnapshot } =
    require('../router/modelRegistry.js') as typeof import('../router/modelRegistry.js')
  const { configuredDefaultProvider } =
    require('./defaultProviderRung.js') as typeof import('./defaultProviderRung.js')
  const providers = buildRouterModelSnapshot().providers
  const ledger = readSignInLedger()
  const credentials: CredentialFact[] = providerFamilyPresences(providers)
    .filter(presence => presence.credentialed)
    .map(presence => {
      const record = ledger[presence.id]
      return {
        family: presence.id,
        at: record !== undefined ? record.at : null,
        ...(record !== undefined ? { kind: record.kind } : {}),
        ...(presence.credentialLabel !== undefined ? { label: presence.credentialLabel } : {}),
      }
    })
  const recorded = configuredDefaultProvider()
  return orderCredentials({
    credentials,
    ...(recorded !== undefined ? { recordedDefaultProvider: recorded } : {}),
    registryOrder: providers.map(provider => provider.id),
  })
}

export function mostRecentSignInFamily(): string | undefined {
  try {
    return recentSignIns()[0]?.family
  } catch {
    return undefined
  }
}

export function gatherComputedDefaultFacts(): ComputedDefaultFacts & { degraded: boolean } {
  const { providerFamilyPresences } =
    require('../../services/providers/providerUsage.js') as typeof import('../../services/providers/providerUsage.js')
  const { buildRouterModelSnapshot } =
    require('../router/modelRegistry.js') as typeof import('../router/modelRegistry.js')
  const { configuredDefaultProvider } =
    require('./defaultProviderRung.js') as typeof import('./defaultProviderRung.js')
  const { providerDisplayName } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  const providers = buildRouterModelSnapshot().providers
  const ledger = readSignInLedger()
  const credentials: CredentialFact[] = providerFamilyPresences(providers)
    .filter(presence => presence.credentialed)
    .map(presence => {
      const record = ledger[presence.id]
      return {
        family: presence.id,
        at: record !== undefined ? record.at : null,
        ...(record !== undefined ? { kind: record.kind } : {}),
        ...(presence.credentialLabel !== undefined ? { label: presence.credentialLabel } : {}),
      }
    })
  const recorded = configuredDefaultProvider()
  let rows: ModelOption[] | null | undefined
  const facts: ComputedDefaultFacts & { degraded: boolean } = {
    credentials,
    ...(recorded !== undefined ? { recordedDefaultProvider: recorded } : {}),
    registryOrder: providers.map(provider => provider.id),
    laneRow: family => {
      if (family === 'anthropic') return liveFirstPartyRow()
      if (KEY_LANES.has(family)) return keyLaneRow(family as 'zai' | 'moonshot' | 'deepseek')
      if (rows === undefined) {
        rows = livePickerRows()
        if (rows === null) facts.degraded = true
      }
      return pickerRowFor(family, rows)
    },
    keyless: liveKeyless(),
    providerName: providerDisplayName,
    degraded: false,
  }
  return facts
}

const MEMO_TTL_MS = 2_000
let memo: { at: number; epoch: number; catalogue: number; decision: ComputedDefault } | null = null

export function resetComputedDefaultMemo(): void {
  memo = null
}

export function computedDefault(): ComputedDefault {
  const epoch = signInLedgerEpoch()
  const catalogue = catalogueEpoch()
  const now = Date.now()
  if (memo !== null && memo.epoch === epoch && memo.catalogue === catalogue && now - memo.at < MEMO_TTL_MS) {
    return memo.decision
  }
  if (walkingPicker) {
    return evaluateComputedDefault({
      credentials: [],
      registryOrder: [],
      laneRow: () => ({ usable: false, why: 'the catalogue is being composed' }),
      keyless: liveKeyless(),
    })
  }
  const facts = gatherComputedDefaultFacts()
  const decision = evaluateComputedDefault(facts)
  if (!facts.degraded) memo = { at: now, epoch, catalogue, decision }
  return decision
}

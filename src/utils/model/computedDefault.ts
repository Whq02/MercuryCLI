// ============================================================================
//  model/computedDefault — the ONE owner of the computed, provider-neutral
//  default (the operator's ruling: "the most recent sign-in acts
//  as the default; true neutrality" — the ideology's second law applied to
//  the default: no provider is the skeleton).
//
//  THE RULE:  default = newestUsableRow(provider(the most recent sign-in))
//    · the most recent sign-in decides the PROVIDER — the sign-in ledger
//      (utils/accounts/signInLedger) records when each family's credential
//      landed, and this resolver re-reads it on every call, so a new
//      sign-in moves the default at once (a boot, /logins, the Boot face's
//      logins layer alike);
//    · that family's newest USABLE row is the default — a gated row (one
//      the signed-in credential cannot select: the picker's `unavailable`
//      rows, a first-party row the account's evidence does not clear)
//      never becomes the default. The picker already knows gating; this
//      resolver reads the same verdicts, never a second opinion;
//    · a family whose most recent sign-in offers no usable row falls
//      through to the NEXT most recent sign-in — named, never silent;
//    · with no sign-in anywhere there is NO computed default: the Default
//      row, /model, the boot face and the doctor say "no sign-in yet" and
//      point at /logins, and nothing names a provider the user cannot use.
//      The harness still needs a model STRING for a session (the dispatch
//      door refuses without a credential, typed), so the keyless answer
//      carries the first-party family's fallback setting as an internal
//      placeholder that no surface paints as the default;
//    · an EXPLICIT choice (the persisted /model slot, ANTHROPIC_MODEL, the
//      session override) is not this resolver's business — it outranks the
//      default at getUserSpecifiedModelSetting (model.ts), and the proof
//      pins that precedence on the live chain;
//    · the family aliases ('fable', 'gpt', 'glm', 'opus', 'sonnet') keep
//      meaning each provider's family; "the default" is this computed thing.
//
//  Credentials WITHOUT a recorded sign-in time — one that landed before the
//  ledger existed, an env-pinned key, a configured keyless endpoint — order
//  AFTER every timed sign-in, labelled so. Among them the home's recorded
//  default provider (config.defaultProvider — the one sign-in ORDER fact a
//  home carried before the ledger) leads, then the provider registry's
//  order: a home that gains this resolver keeps the lane it had until its
//  next sign-in, and the copy says why.
//
//  Shape: a PURE evaluator over a typed facts record (the provable core —
//  scripts/default-model/ drives it with injected facts, the F6 ambient-
//  state law) plus a thin live gatherer over the EXISTING owners (the
//  presence enumeration, the ledger, the picker's rows, the first-party
//  frontier decision). No network, no writes, no new stores. Every model-
//  estate neighbour is a call-time require (the frontierPolicy /
//  defaultProviderRung cycle law), so model.ts reads this module without a
//  load-time cycle. The live decision is memoised for a moment (2 s, and
//  never across a sign-in landed in this process): the main-loop model is
//  read on every render, and the presence enumeration is a dozen file
//  reads.
// ============================================================================
import type { CallModelRoute } from '../../services/providers/routeLaw.js'
import type { ModelOption } from './modelOptions.js'
import { catalogueEpoch } from '../../services/providers/catalogueEpoch.js'
import { readSignInLedger, signInLedgerEpoch, type SignInKind } from '../accounts/signInLedger.js'

export type ComputedDefaultSource = 'sign-in' | 'fallthrough' | 'keyless'

/** The keyless words — the one spelling every surface paints (the Default
 *  row's reason, the boot face's chip, /model's label, the doctor). */
export const NO_SIGN_IN_ROW = 'no sign-in yet'
export const NO_SIGN_IN_REASON = 'no sign-in yet — /logins signs a provider in'
/** The keyless row word when sign-ins EXIST but none offers a usable row
 *  yet (a live catalogue still composing, or unreachable): a compact
 *  surface (the boot face's model chip, /defaultprovider's standing line)
 *  must not say "no sign-in yet" beside a named sign-in. The fuller
 *  surfaces (the Default row, /model's label) carry the decision's why,
 *  which names each sign-in's gate and the logins door. */
export const NO_USABLE_ROW = 'no usable row yet'

/** One credentialed family with its recorded sign-in (or none). */
export interface CredentialFact {
  family: string
  /** Epoch ms the credential landed from a sign-in; null = not recorded. */
  at: number | null
  kind?: SignInKind
  /** The owning resolver's display words for the credential — never a secret. */
  label?: string
}

/** A family's answer to "the newest row this credential can use". */
export type LaneRowVerdict =
  | { usable: true; setting: string; row: string; why: string }
  | { usable: false; why: string }

/** The keyless resolution — the placeholder setting that stands with no
 *  usable sign-in (never painted as the default), and the words. */
export interface KeylessFact {
  setting: string
  why: string
}

/**
 * The typed facts the PURE evaluator consumes — gathered live from the
 * existing owners, or injected verbatim by the proof matrix.
 */
export interface ComputedDefaultFacts {
  /** Every credentialed family, unordered. */
  credentials: CredentialFact[]
  /** config.defaultProvider — the untimed tiebreak (see the header). */
  recordedDefaultProvider?: string
  /** The provider registry's order — the tiebreak after the recorded one. */
  registryOrder: readonly string[]
  /** The family's newest usable row, with the reason either way. */
  laneRow: (family: string) => LaneRowVerdict
  keyless: KeylessFact
  /** Display words for a family id (default: the id itself). */
  providerName?: (family: string) => string
  /** Display words for a sign-in time (default: a UTC stamp). */
  formatTime?: (ms: number) => string
}

/** One credential in recency order, with its verdict and its place in words. */
export interface ConsideredCredential extends CredentialFact {
  timed: boolean
  /** Operator words for the sign-in's place in the order. */
  recency: string
  verdict: LaneRowVerdict
}

/** The one computed-default decision. */
export interface ComputedDefault {
  /** The model-SETTING string a fresh unpinned session resolves (the
   *  keyless placeholder when source === 'keyless'). */
  setting: string
  /** The row's display words — when keyless, NO_SIGN_IN_ROW with no
   *  credential anywhere, NO_USABLE_ROW when sign-ins exist but none
   *  offers a usable row yet. */
  row: string
  /** The family the default landed on; null when keyless. */
  provider: string | null
  source: ComputedDefaultSource
  /** The deciding credential when source !== 'keyless'. */
  chosen: ConsideredCredential | null
  /** Every credentialed family, recency-ordered, each with its verdict. */
  considered: ConsideredCredential[]
  /** The whole reason in one operator-facing line. */
  why: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A deterministic UTC stamp — the same words on every machine and zone. */
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

/**
 * The recency order (pure): timed sign-ins newest first (ties: the registry
 * order), then every untimed credential — the recorded default provider
 * first, then the registry order, then anything the registry does not name.
 */
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

/**
 * THE computed-default decision — the PURE core. Deterministic over `facts`;
 * no reads, no writes. The proof matrix drives every ordering, gating,
 * fallthrough and keyless row through this function with injected facts.
 */
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
            .join('; ')}) — /model names a row by id, or /logins signs another provider in`
    return {
      setting: facts.keyless.setting,
      // The row word tells the two keyless states apart: no credential
      // anywhere, or sign-ins whose rows are not usable (yet).
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

/** The source in the fewest operator words (never for a keyless answer). */
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

/** The keyless reason in ONE spelling: the logins door when no credential
 *  exists anywhere; the decision's own why (each sign-in's gate, then the
 *  logins door) when sign-ins exist but none offers a usable row yet. The
 *  Default row's description and its selectability reason read this. */
export function keylessReason(decision: Pick<ComputedDefault, 'considered' | 'why'>): string {
  return decision.considered.length === 0 ? NO_SIGN_IN_REASON : decision.why
}

/**
 * The Default row's description — the neutral catalogue grammar
 * 'Default (<name>)' (prove-model-honesty §7), the name carrying the row,
 * the provider and the source in the fewest words:
 *   Default (GPT-5.5 — OpenAI, the most recent sign-in)
 *   Default (no sign-in yet — /logins signs a provider in)
 *   Default (no sign-in offers a usable row (OpenAI: …) — /logins signs another provider in)
 */
export function describeComputedDefaultRow(
  decision: ComputedDefault,
  providerName: (family: string) => string = identity,
): string {
  if (decision.source === 'keyless' || decision.provider === null) return `Default (${keylessReason(decision)})`
  return `Default (${decision.row} — ${providerName(decision.provider)}, ${sourceWords(decision)})`
}

/**
 * The /model label for a session on the default — the row first, the
 * default word and its reason after:
 *   GPT-5.5 (default — OpenAI, the most recent sign-in)
 *   no sign-in yet (default — /logins signs a provider in)
 *   no usable row yet (default — no sign-in offers a usable row (…) — /logins signs another provider in)
 */
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

/**
 * One terse line for the doctor row and /defaultprovider — the row, the
 * provider and the source, then the recency and the gating words:
 *   GPT-5.5 · OpenAI · the most recent sign-in (subscription sign-in, 2026-09-01 23:20 UTC) · the newest row this sign-in can use (…)
 *   no sign-in yet · no provider is signed in yet — /logins signs one in …
 *   no usable row yet · no sign-in offers a usable row (…) — /logins signs another provider in
 */
export function describeComputedDefault(
  decision: ComputedDefault,
  providerName: (family: string) => string = identity,
): string {
  if (decision.chosen === null || decision.provider === null) {
    return `${decision.row} · ${decision.why}`
  }
  return `${decision.row} · ${providerName(decision.provider)} · ${decision.chosen.recency} · ${decision.chosen.verdict.why}`
}

// ── The live gatherer (read-only over the existing owners) ─────────────────

/** The first-party family's evidence words — the reason its frontier row
 *  is usable (frontierPolicy's eligibility codes, in neutral words). */
const FIRST_PARTY_EVIDENCE: Record<string, string> = {
  'eligible-env-pin': 'the ANTHROPIC_DEFAULT_FABLE_MODEL pin names it',
  'eligible-allowlist': 'the model allowlist names it',
  'eligible-max-20x': 'a confirmed Max 20x subscription',
}

/** …and the gate words — what the frontier row needs that this credential
 *  does not show (the next row down is then the newest usable one). */
const FIRST_PARTY_GATE: Record<string, string> = {
  'not-subscriber': 'a Claude subscription at the confirmed Max 20x tier (this credential is not a subscription)',
  'not-max': 'a Max subscription at the confirmed 20x tier',
  'unknown-rate-limit-tier': "a confirmed Max 20x tier (this subscription's tier is not known yet)",
  'not-20x': 'the Max 20x tier',
  'allowlist-excluded': 'a place on the model allowlist',
  'no-registered-candidate': 'a registered frontier row',
}

/** The first-party lane: the frontier decision IS that family's gating —
 *  its frontier row when the account's evidence clears it, else the next
 *  row down (the decision's fallback), each with the reason. One family's
 *  gating among equals. */
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

/** The key lanes answer from their own pin tables — the picker's law for
 *  those groups (a present key makes every pin selectable, the first pin
 *  the recorded frontier) WITHOUT composing the picker. A composition kicks
 *  the catalogue lanes' refreshes and the local discovery probes, and a
 *  default resolution must never put a request on the wire: a routed
 *  call's own request has to stand alone (the s5 backends fixture saw its
 *  request body overwritten by exactly such a probe). */
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

/** Reentrancy latch for the picker walk: the picker's own Default row
 *  renders this resolver, which composes the picker — inside a composition
 *  the inner call gets NO rows (that one render answers the keyless words
 *  and is never memoised) and the OUTER composition lands on the family's
 *  real row. The defaultProviderRung precedent. */
let walkingPicker = false

/** The picker's rows, composed ONCE per decision — null inside a nested
 *  composition (the latch) or when the catalogue cannot be read. */
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

/** The catalogue lanes (openai · openrouter · gemini · huggingface · the
 *  compat slot · local): their rows in the picker's own order, the rows the
 *  picker marks unavailable skipped (the gating the picker already knows —
 *  the live catalogue's qualification), the family's recorded frontier fact
 *  preferred when it is among the selectable rows, else the first
 *  selectable row. */
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

/** The keyless placeholder: the first-party frontier decision's setting
 *  (the pre-ledger answer for a home with no credential) — the harness's
 *  model string, never painted as the default. */
function liveKeyless(): KeylessFact {
  const { frontierOperatorDecision } =
    require('./frontierPolicy.js') as typeof import('./frontierPolicy.js')
  return {
    setting: frontierOperatorDecision().setting,
    why: 'no provider is signed in yet — /logins signs one in, and its newest usable row becomes the default',
  }
}

/** The live credentials in recency order — the presence enumeration joined
 *  with the ledger, no picker walk (the logins card's focus reads this). */
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

/** The family of the most recent sign-in (a credential it still holds), or
 *  undefined with no credential anywhere. */
export function mostRecentSignInFamily(): string | undefined {
  try {
    return recentSignIns()[0]?.family
  } catch {
    return undefined
  }
}

/**
 * Gather the live facts from the EXISTING owners: the presence enumeration
 * (which families hold a credential), the sign-in ledger (when), the
 * recorded default provider (the untimed tiebreak), the registry order, the
 * picker's gating (composed once, lazily). Read-only; no network.
 */
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
  // The picker composes at most once per decision, and only when a family
  // other than the first-party one is asked.
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

/** The live memo — a moment long, never across a sign-in landed here, and
 *  never across a live catalogue settling (the lane rows derive from the
 *  catalogues: a decision taken while one was composing must not outlive
 *  its landing — the boot face's strip reads this on that very epoch). */
const MEMO_TTL_MS = 2_000
let memo: { at: number; epoch: number; catalogue: number; decision: ComputedDefault } | null = null

/** Drop the memo (a proof that moves credentials mid-process calls it). */
export function resetComputedDefaultMemo(): void {
  memo = null
}

/** The live computed-default decision (pure core over gathered facts). */
export function computedDefault(): ComputedDefault {
  const epoch = signInLedgerEpoch()
  const catalogue = catalogueEpoch()
  const now = Date.now()
  if (memo !== null && memo.epoch === epoch && memo.catalogue === catalogue && now - memo.at < MEMO_TTL_MS) {
    return memo.decision
  }
  // Inside a picker composition (the latch) the nested Default row gets the
  // keyless words without a second presence walk — that render is discarded
  // by the outer composition, which lands on the real row.
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
  // A decision taken inside a nested picker composition saw no rows — it
  // answers that one render and is never remembered.
  if (!facts.degraded) memo = { at: now, epoch, catalogue, decision }
  return decision
}

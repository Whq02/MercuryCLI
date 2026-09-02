// ============================================================================
//  providers/accountSlots — the /accounts SLOT derivation seam (the
//  operator ruling: /logout leaves everything; /accounts sees and
//  manages each login individually).
//
//  One slot per signed-in identity across EVERY provider family the router
//  catalogue knows — derived, never hardcoded: the family list comes from
//  providerFamilyPresences (the enumeration law), each family's
//  slots from its OWNING account resolvers:
//    · anthropic — the Mercury scope ring (utils/accounts/scopeScan — the ONE
//      slot-universe owner the wallet shares) plus the API-key ladder
//      (utils/auth getAnthropicApiKeyWithSource, source-honest);
//    · openai   — the subscription store AND the key resolver, both shown
//      when both exist (services/providers/openai/openaiAccounts; the stored
//      key rests with utils/router/providerSecrets);
//    · zai      — env ZAI_API_KEY and the stored key
//      (utils/router/providerSecrets), env pin honestly marked the winner;
//    · ANY OTHER id — the adapter's own account view (description.account),
//      so a family added to the catalogue yields its slot with NO edit here
//      and none on the board.
//  Slots carry presence facts and masked key TAILS only — never a secret
//  value (the providerSecrets law; the tail is the industry key-management
//  display form the lane brief rules in).
//
//  Removal is ROUTED, never inlined: executeSlotRemoval maps each slot to its
//  owning store. Env-pinned keys are the shell's — shown, refused honestly,
//  never edited. Dark lanes never reach this module (filtered at the
//  presence, so a deliberately OFF family is never advertised).
//
//  CEILINGS (the account-slot simplification): at
//  most TWO concurrent Mercury-held sign-ins for anthropic (OAuth + managed
//  key) and TWO for openai (ChatGPT subscription + stored key) —
//  familySigninCeiling owns the numbers, signinCeilingRefusal is the ONE
//  typed refusal any sign-in path must consult before ADDING a concurrent
//  login (every current store is single-entry, so a fresh sign-in REPLACES
//  its slot and the ceiling is structural; the refusal is the gate that
//  keeps a third concurrent path from regrowing). Env pins are the shell's
//  environment — displayed and precedence-honored, never a Mercury-held
//  sign-in, never refusable.
// ============================================================================
import { providerDisplayName, declaredRouteOf, type CallModelRoute } from './routeLaw.js'
import type { ScopeIdentityState } from '../../utils/accounts/accountIdentity.js'
import { noteCredentialRemoval } from '../../utils/accounts/signInLedger.js'
import {
  clearOAuthTokenCache,
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
  removeApiKey,
  type ApiKeySource,
} from '../../utils/auth.js'
import { revokeOAuthToken } from '../oauth/client.js'
import { removeSecureStorageField } from '../../utils/secureStorage/index.js'
import { saveGlobalConfig } from '../../utils/config/globalConfig.js'
import { resetUserCache } from '../../utils/user.js'
import { logError } from '../../utils/log.js'
import {
  scanAccountScopes,
  type AccountScope,
} from '../../utils/accounts/scopeScan.js'
import {
  readStoredGeminiApiKey,
  readStoredOpenrouterApiKey,
  readStoredZaiApiKey,
  readStoredZaiKeyPlan,
  writeStoredGeminiApiKey,
  readStoredCompatApiKey,
  readStoredDeepseekApiKey,
  readStoredHuggingfaceApiKey,
  readStoredLocalApiKey,
  readStoredMoonshotApiKey,
  writeStoredCompatApiKey,
  writeStoredDeepseekApiKey,
  writeStoredHuggingfaceApiKey,
  writeStoredLocalApiKey,
  writeStoredMoonshotApiKey,
  writeStoredOpenaiApiKey,
  writeStoredOpenrouterApiKey,
  writeStoredZaiApiKey,
} from '../../utils/router/providerSecrets.js'
import {
  disconnectOpenrouterOauthKey,
  readMintedOpenrouterKey,
} from './openrouter/openrouterAccounts.js'
import {
  disconnectGeminiOauth,
  geminiOauthConnected,
  resolveGeminiAccount,
  type GeminiAccountRef,
} from './gemini/geminiAccounts.js'
import {
  disconnectMoonshotOauth,
  kimiRegionLabel,
  moonshotLoginRegion,
  moonshotStoredTokens,
  type KimiRegion,
} from './moonshot/moonshotAccounts.js'
import {
  disconnectHuggingfaceOauth,
  huggingfaceOauthIdentity,
  huggingfaceStoredTokenIdentity,
  huggingfaceStoredTokens,
  type HuggingfaceIdentity,
} from './huggingface/huggingfaceAccounts.js'
import { resolveLocalAccount, type LocalAccountRef } from './local/localAccounts.js'
import {
  buildRouterModelSnapshot,
  type RouterModelSnapshot,
} from '../../utils/router/modelRegistry.js'
import {
  disconnectOpenaiSubscription,
  openaiSubscriptionPresence,
  openaiSubscriptionRef,
  resolveOpenaiAccount,
  resolveOpenaiApiKey,
  type OpenaiAccountRef,
} from './openai/openaiAccounts.js'
import {
  presenceIdentityWords,
  providerFamilyPresences,
  type ProviderFamilyPresence,
  type ProviderFamilyReads,
} from './providerUsage.js'

export type AccountSlotKind = 'oauth' | 'subscription' | 'api-key'

export type SlotRemoval =
  | { route: 'anthropic-oauth'; dir: string }
  | { route: 'anthropic-managed-key' }
  | { route: 'openai-subscription' }
  | { route: 'openai-stored-key' }
  | { route: 'zai-stored-key' }
  | { route: 'openrouter-oauth-key' }
  | { route: 'openrouter-stored-key' }
  | { route: 'gemini-oauth' }
  | { route: 'gemini-stored-key' }
  | { route: 'moonshot-stored-key' }
  | { route: 'moonshot-oauth' }
  | { route: 'deepseek-stored-key' }
  | { route: 'compat-stored-key' }
  | { route: 'huggingface-oauth' }
  | { route: 'huggingface-stored-key' }
  | { route: 'local-stored-key' }
  /** Shell-owned env pin — shown, never removable here. */
  | { route: 'env'; envVar: string }
  /** Settings-owned credential (apiKeyHelper) — settings remove it. */
  | { route: 'settings'; note: string }
  /** A family whose credential store lives elsewhere — name the route. */
  | { route: 'owner'; note: string }
  /** Present for honesty, never ours to act on (the base harness scopes). */
  | { route: 'excluded'; note: string }

/** One signed-in identity (or ring position) on the /accounts board. Never
 *  carries a secret — identities are emails, labels, sources, masked tails. */
export interface AccountSlot {
  /** Catalogue family id (string-open: future families flow through). */
  family: string
  /** Stable row id (the scope dir for ring slots; `family:kind` otherwise). */
  id: string
  /** Short handle for the name column (scope name / 'chatgpt' / 'api-key'). */
  name: string
  kind: AccountSlotKind
  /** Display words for the kind — env-pinned keys say so. */
  kindLabel: string
  /** Email / account label / key source + masked tail. Never a secret. */
  identity: string
  /** The source a dispatch on this family would bill right now. */
  active: boolean
  /** Shell-owned env pin: shown, never removable from the board. */
  envPinned: boolean
  /** A credential EXISTS for this slot (the scan's authed probe for a
   *  scope; a stored key/token for the rest) — existence, never validity.
   *  The board's sign-in answer is slotSigninState, which folds the live
   *  identity verification over this fact. */
  signedIn: boolean
  /** Present exactly when this is an Anthropic scope-ring slot — the board's
   *  live-identity overlay and switch/reauth arms key on it. */
  scope?: AccountScope
  /** Extra state words (e.g. 'shadowed — the env pin wins'). */
  stateNote?: string
  removal: SlotRemoval
}

export interface FamilySlotGroup {
  family: ProviderFamilyPresence
  /** Empty = no login anywhere for this family (the board's absent row). */
  slots: AccountSlot[]
}

/** Injectable owner reads for provers; production callers pass nothing. */
export interface AccountSlotReads {
  familyReads?: ProviderFamilyReads
  scanScopes?: () => AccountScope[]
  anthropicApiKey?: () => { key: string | null; source: ApiKeySource }
  openaiSubscription?: () => OpenaiAccountRef | undefined
  /** Present-but-dead honesty: the subscription sign-in's presence state
   *  (a blanked grant is 'expired' — the row stays, signedIn false). */
  openaiSubscriptionPresence?: () => { state: 'connected' | 'expired' | 'absent'; email?: string; planType?: string }
  openaiActiveAccount?: () => OpenaiAccountRef | undefined
  openaiApiKey?: () => { key: string; source: 'env' | 'stored' } | undefined
  zaiEnvKey?: () => string | undefined
  zaiStoredKey?: () => string | undefined
  /** 'coding' when the stored Z.AI key is a GLM Coding Plan key. */
  zaiStoredKeyPlan?: () => 'coding' | undefined
  openrouterEnvKey?: () => string | undefined
  openrouterMintedKey?: () => { key: string; mintedAtMs: number } | undefined
  openrouterStoredKey?: () => string | undefined
  geminiOauthConnected?: () => boolean
  geminiActiveAccount?: () => GeminiAccountRef | undefined
  geminiEnvGoogleKey?: () => string | undefined
  geminiEnvGeminiKey?: () => string | undefined
  geminiStoredKey?: () => string | undefined
  moonshotEnvKey?: () => string | undefined
  moonshotStoredKey?: () => string | undefined
  moonshotOauth?: () =>
    | { accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number }
    | undefined
  /** The region the Kimi sign-in was made in (the login remembers it). */
  moonshotOauthRegion?: () => KimiRegion
  deepseekEnvKey?: () => string | undefined
  deepseekStoredKey?: () => string | undefined
  compatEnvKey?: () => string | undefined
  compatStoredKey?: () => string | undefined
  huggingfaceEnvKey?: () => string | undefined
  huggingfaceOauth?: () =>
    | { accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number }
    | undefined
  huggingfaceOauthIdentity?: () => HuggingfaceIdentity | undefined
  huggingfaceStoredKey?: () => string | undefined
  huggingfaceStoredKeyIdentity?: (key: string | undefined) => HuggingfaceIdentity | undefined
  localEnvKey?: () => string | undefined
  localStoredKey?: () => string | undefined
  localAccount?: () => LocalAccountRef | undefined
}

/** Last-four masked tail for an API key ('…abcd'), or '' for short values —
 *  the ONLY key-derived text that may ride a slot. */
export function maskedKeyTail(key: string | undefined): string {
  const trimmed = key?.trim() ?? ''
  return trimmed.length >= 10 ? `…${trimmed.slice(-4)}` : ''
}

/** Known-id display names (presentation only — an unknown id shows itself,
 *  so a future family is never silent). Delegates to the ONE provider
 *  naming owner beside the id-space table (routeLaw.ts). */
export function familyDisplayName(id: string): string {
  return providerDisplayName(id)
}

// ── Per-family sign-in ceilings ────────────────

const FAMILY_SIGNIN_CEILINGS: Readonly<Record<string, number>> = {
  anthropic: 2,
  openai: 2,
}

/** The family's concurrent sign-in ceiling, or undefined (no ceiling ruled —
 *  the family keeps its own structural shape). */
export function familySigninCeiling(family: string): number | undefined {
  return FAMILY_SIGNIN_CEILINGS[family]
}

// ── THE sign-in derivation ───────────────────────────────────────────────────
//  One answer per slot, consumed by the family header's count AND the row's
//  state words, so the two can never disagree (the operator
//  finding: the header counted a credential's EXISTENCE — "1/2 signed in" —
//  while the row's live verification read "not signed in"). A scope slot's
//  answer is the live identity verification of its OWN credential
//  (utils/accounts/accountIdentity); a stored key/token has no live probe on
//  this board and counts by existence, labelled so. The labelled offline
//  snapshot is never a sign-in.

/** The board's live identity read for one scope, as the view holds it:
 *  the verifier's answer, 'checking' while the probe is in flight, or
 *  absent before it began (treated as checking). */
export type SlotIdentityRead = ScopeIdentityState | { state: 'checking' }
export type SlotIdentities = Readonly<Record<string, SlotIdentityRead | undefined>>

export type SlotSigninBasis =
  /** The OAuth profile endpoint answered for the scope's own credential. */
  | 'verified-live'
  /** A stored credential exists; no live probe exists for it on this board. */
  | 'credential-present'
  /** The live probe is in flight (or has not started). */
  | 'checking'
  /** The profile endpoint refused the credential (401/403). */
  | 'expired'
  /** No credential in the scope. */
  | 'signed-out'
  /** The probe could not reach the endpoint — the labelled snapshot stands. */
  | 'unverified'
  /** Another tool's credential scope — never billable from Mercury. */
  | 'excluded'
  /** No credential for a non-scope slot. */
  | 'absent'

export type SlotSigninState =
  | { signedIn: true; basis: 'verified-live' | 'credential-present' }
  | { signedIn: false; basis: Exclude<SlotSigninBasis, 'verified-live' | 'credential-present'> }

export function slotSigninState(slot: AccountSlot, identities: SlotIdentities): SlotSigninState {
  if (slot.scope === undefined) {
    return slot.signedIn
      ? { signedIn: true, basis: 'credential-present' }
      : { signedIn: false, basis: 'absent' }
  }
  if (slot.scope.claudeFamily) return { signedIn: false, basis: 'excluded' }
  const identity = identities[slot.id]
  switch (identity?.state) {
    case 'verified':
      return { signedIn: true, basis: 'verified-live' }
    case 'expired':
      return { signedIn: false, basis: 'expired' }
    case 'signed-out':
      return { signedIn: false, basis: 'signed-out' }
    case 'unverified':
      return { signedIn: false, basis: 'unverified' }
    default:
      return { signedIn: false, basis: 'checking' }
  }
}

export interface FamilySigninSummary {
  /** Slots signed in by the one derivation, every source (env pins too). */
  signedIn: number
  /** Mercury-HELD sign-ins: the signed-in slots that are not the shell's
   *  env pins (the ceiling counts these). */
  held: number
  /** Scope slots whose live probe has not answered yet. */
  checking: number
  /** Scope slots whose probe could not reach the endpoint (offline) — a
   *  labelled snapshot, not a sign-in. */
  unverified: number
}

/** The family's sign-in facts from the one derivation. */
export function familySigninSummary(
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): FamilySigninSummary {
  const summary: FamilySigninSummary = { signedIn: 0, held: 0, checking: 0, unverified: 0 }
  for (const slot of slots) {
    const state = slotSigninState(slot, identities)
    if (state.signedIn) {
      summary.signedIn += 1
      if (!slot.envPinned) summary.held += 1
    } else if (state.basis === 'checking') {
      summary.checking += 1
    } else if (state.basis === 'unverified') {
      summary.unverified += 1
    }
  }
  return summary
}

/** Mercury-HELD sign-ins on a family's slots, from the one derivation
 *  (env pins are the shell's environment, not a sign-in; a scope whose
 *  live verification has not passed is not a sign-in). */
export function familySigninCount(
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): number {
  return familySigninSummary(slots, identities).held
}

/** The ceilinged family header's sign-in words — the held count against
 *  the ceiling, then the in-flight and offline facts so a low count is
 *  never read as a denial while the probe is still out. Empty for a family
 *  with no ruled ceiling (its header carries the plain count chip). */
export function familySigninHeaderNote(
  family: string,
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): string {
  const ceiling = familySigninCeiling(family)
  if (ceiling === undefined) return ''
  const summary = familySigninSummary(slots, identities)
  const parts = [`${summary.held}/${ceiling} signed in`]
  if (summary.checking > 0) parts.push('verifying…')
  if (summary.unverified > 0) {
    parts.push(`${summary.unverified} unverified (offline)`)
  }
  return ` · ${parts.join(' · ')}`
}

// ── the main loop's billing identity ────────────────────────────────────────
//  The summary row derives from the main model's ACTUAL route (the routing
//  law) and that family's credential from its owning resolver (the presence
//  enumeration) — never the Anthropic scope's snapshot whatever the route
//  (the finding: a "main loop" line naming the Anthropic account
//  "(snapshot)" while the session ran on the OpenAI subscription).

export type MainLoopIdentityBasis =
  | 'verified-live'
  | 'credential-present'
  | 'discovered-live'
  | 'checking'
  | 'expired'
  | 'unverified'
  | 'not-signed-in'
  | 'excluded'

export interface MainLoopIdentity {
  /** 'unrecognised' = no family declares the session model — the identity
   *  row paints the honest word, never a borrowed family's account state. */
  route: CallModelRoute | 'unrecognised'
  /** The family's display name (the one naming owner). */
  family: string
  /** The row's value: the identity or its absence, the basis word inside —
   *  a snapshot is always labelled as one. */
  text: string
  basis: MainLoopIdentityBasis
}

export interface MainLoopIdentityInput {
  /** The main loop's model (the session override when one is engaged). */
  model: string
  /** The presence enumeration (providerFamilyPresences). */
  presences: readonly ProviderFamilyPresence[]
  /** The board's live read of the CURRENT scope — consulted only when the
   *  route is anthropic and the credential is the OAuth subscription. */
  currentScopeIdentity?: SlotIdentityRead | undefined
  /** The current scope is a foreign Claude-family home (never billable). */
  currentScopeClaudeFamily?: boolean
}

/** The attach home for a family, in the ONE spelling every picker uses
 *  (subModelSlots.subModelConnectHome — required at call time: that module
 *  imports the catalogue, which reaches back into this seam's owners). */
function connectHomeWords(route: CallModelRoute | string): string {
  const { subModelConnectHome } =
    require('../../utils/model/subModelSlots.js') as typeof import('../../utils/model/subModelSlots.js')
  const home = subModelConnectHome(route)
  return home.command ?? home.note
}

export function mainLoopIdentity(input: MainLoopIdentityInput): MainLoopIdentity {
  const route = declaredRouteOf(input.model) ?? 'unrecognised'
  const family = familyDisplayName(route)
  const presence = input.presences.find(candidate => (candidate.id as string) === route)
  const notSignedIn = (): MainLoopIdentity => ({
    route,
    family,
    text: `not signed in — ${connectHomeWords(route)}`,
    basis: 'not-signed-in',
  })
  if (presence === undefined || !presence.credentialed) return notSignedIn()
  const label = presence.credentialLabel ?? 'credential present'
  if (route !== 'anthropic') {
    // A discovered local server is a live fact (the resolver probed it);
    // every other family's credential is an existence fact on this board —
    // named by the ONE identity composer (the sign-in's email when its
    // store recorded one, else the plan/source label).
    const words = presenceIdentityWords(presence) ?? label
    return route === 'local'
      ? { route, family, text: `${words} · discovered live`, basis: 'discovered-live' }
      : { route, family, text: `${words} · credential present`, basis: 'credential-present' }
  }
  // Anthropic: the subscription bills the scope's OAuth login, which the
  // board verifies live; a key or env bearer bills itself (no live probe).
  if (!label.startsWith('Claude subscription')) {
    return { route, family, text: `${label} · credential present`, basis: 'credential-present' }
  }
  if (input.currentScopeClaudeFamily) {
    return {
      route,
      family,
      text: "another tool's credential scope — never billable from Mercury",
      basis: 'excluded',
    }
  }
  const identity = input.currentScopeIdentity
  switch (identity?.state) {
    case 'verified':
      return { route, family, text: `${identity.email} · verified live`, basis: 'verified-live' }
    case 'expired':
      return {
        route,
        family,
        text: `not signed in — credential expired${identity.snapshotEmail ? ` (snapshot ${identity.snapshotEmail})` : ''} · ↵ on the Anthropic slot reauths`,
        basis: 'expired',
      }
    case 'signed-out':
      return notSignedIn()
    case 'unverified':
      return {
        route,
        family,
        text: `${label} · unverified — ${identity.note}${identity.email ? ` · snapshot ${identity.email}` : ''}`,
        basis: 'unverified',
      }
    default:
      return { route, family, text: `${label} · verifying identity…`, basis: 'checking' }
  }
}

/** The typed ceiling refusal (ideology law 3: a ceiling refuses typed, never
 *  silently drops). Returns undefined while headroom remains; any path that
 *  would ADD a concurrent sign-in (not re-login/replace one) must consult
 *  this before opening a flow. */
export interface SigninCeilingRefusal {
  refused: true
  family: string
  ceiling: number
  current: number
  message: string
}
export function signinCeilingRefusal(
  family: string,
  currentSignins: number,
): SigninCeilingRefusal | undefined {
  const ceiling = familySigninCeiling(family)
  if (ceiling === undefined || currentSignins < ceiling) return undefined
  return {
    refused: true,
    family,
    ceiling,
    current: currentSignins,
    message: `${familyDisplayName(family)} is at its sign-in ceiling (${currentSignins}/${ceiling} concurrent) — sign out of one slot first (⌫ on /accounts); re-login of an existing slot is always allowed`,
  }
}

const label = (parts: (string | undefined)[]): string => parts.filter(Boolean).join(' ')

/** The key ladder, render-safe: never executes the helper from a read path
 *  and swallows the CI/test no-credential throw (a state, not an error). */
function readAnthropicApiKey(): { key: string | null; source: ApiKeySource } {
  try {
    return getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
  } catch {
    return { key: null, source: 'none' }
  }
}

function anthropicSlots(reads: AccountSlotReads): AccountSlot[] {
  const scopes = (reads.scanScopes ?? scanAccountScopes)()
  // The billing seat (the slot preference): the subscriber
  // predicate already folds the operator's active-slot preference, so with
  // the managed key seated the OAuth row honestly paints NOT active — one
  // active slot per family, the seat the wire would bill.
  const subscriberSeat = reads.familyReads?.claudeSubscriber?.() ?? isClaudeAISubscriber()
  const slots: AccountSlot[] = scopes.map(scope => ({
    family: 'anthropic',
    id: scope.dir,
    name: scope.name,
    kind: 'oauth' as const,
    kindLabel: 'OAuth',
    identity: scope.claudeFamily
      ? "another tool's credential scope"
      : (scope.email ?? (scope.authed ? 'signed in' : 'not signed in')),
    active: scope.claudeFamily ? scope.isCurrent : scope.isCurrent && subscriberSeat,
    envPinned: false,
    signedIn: scope.authed,
    scope,
    removal: scope.claudeFamily
      ? {
          route: 'excluded' as const,
          note: "another tool's credential scope is not a Mercury slot — nothing to remove here",
        }
      : { route: 'anthropic-oauth' as const, dir: scope.dir },
  }))
  const apiKey = reads.anthropicApiKey ? reads.anthropicApiKey() : readAnthropicApiKey()
  // A helper-sourced key reports its source with no value (never executed
  // from a render read) — the slot still shows, honestly settings-owned.
  if (apiKey.key !== null || apiKey.source === 'apiKeyHelper') {
    const subscriber = subscriberSeat
    const env = apiKey.source === 'ANTHROPIC_API_KEY'
    const helper = apiKey.source === 'apiKeyHelper'
    slots.push({
      family: 'anthropic',
      id: 'anthropic:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: env ? 'API key · env' : helper ? 'API key · helper' : 'API key',
      identity: label([
        env ? 'ANTHROPIC_API_KEY (env)' : helper ? 'apiKeyHelper (settings)' : apiKey.source,
        maskedKeyTail(apiKey.key ?? undefined),
      ]),
      active: !subscriber,
      envPinned: env,
      signedIn: true,
      removal: env
        ? { route: 'env', envVar: 'ANTHROPIC_API_KEY' }
        : helper
          ? {
              route: 'settings',
              note: 'the apiKeyHelper setting owns this key — remove the helper from settings to remove it',
            }
          : { route: 'anthropic-managed-key' },
    })
  }
  return slots
}

function openaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const subscription = (reads.openaiSubscription ?? openaiSubscriptionRef)()
  const key = (reads.openaiApiKey ?? resolveOpenaiApiKey)()
  const active = (reads.openaiActiveAccount ?? resolveOpenaiAccount)()
  const slots: AccountSlot[] = []
  // PRESENT-BUT-DEAD (the anthropic scope row's parity): a
  // sign-in whose grant the AS killed (invalid_grant → blanked refresh
  // token) keeps its row — signedIn false, the expiry and the road named —
  // instead of vanishing into "not connected". ⌫ still clears the dead
  // tokens through the same owning store.
  if (subscription === undefined) {
    const presence = (reads.openaiSubscriptionPresence ?? openaiSubscriptionPresence)()
    if (presence.state === 'expired') {
      slots.push({
        family: 'openai',
        id: 'openai:subscription',
        name: 'chatgpt',
        kind: 'subscription',
        kindLabel: presence.planType ? `${presence.planType} subscription` : 'subscription',
        identity: presence.email ?? 'ChatGPT sign-in',
        active: false,
        envPinned: false,
        signedIn: false,
        stateNote: 'sign-in expired — /logins openai signs in again',
        removal: { route: 'openai-subscription' },
      })
    }
  }
  if (subscription) {
    // Identity is WHO when the provider yielded an email (captured from the
    // id_token's standard claim at login/refresh — the Anthropic row's
    // parity), else the truthful plan label — never blank. The plan moves
    // into the kind label so both facts survive on the row.
    slots.push({
      family: 'openai',
      id: 'openai:subscription',
      name: 'chatgpt',
      kind: 'subscription',
      kindLabel: subscription.planType
        ? `${subscription.planType} subscription`
        : 'subscription',
      identity: subscription.email ?? subscription.label,
      active: active?.kind === 'chatgpt-subscription',
      envPinned: false,
      signedIn: true,
      removal: { route: 'openai-subscription' },
    })
  }
  if (key) {
    const env = key.source === 'env'
    slots.push({
      family: 'openai',
      id: 'openai:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: env ? 'API key · env' : 'API key',
      identity: label([
        env ? 'OPENAI_API_KEY (env)' : 'stored key (auth-scoped)',
        maskedKeyTail(key.key),
      ]),
      active: active?.kind === 'api-key',
      envPinned: env,
      signedIn: true,
      removal: env
        ? { route: 'env', envVar: 'OPENAI_API_KEY' }
        : { route: 'openai-stored-key' },
    })
  }
  return slots
}

function zaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.zaiEnvKey ? reads.zaiEnvKey() : process.env.ZAI_API_KEY?.trim() || undefined
  const storedKey = (reads.zaiStoredKey ?? readStoredZaiApiKey)()
  const storedPlan = (reads.zaiStoredKeyPlan ?? readStoredZaiKeyPlan)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'zai',
      id: 'zai:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['ZAI_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'ZAI_API_KEY' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'zai',
      id: 'zai:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: storedPlan === 'coding' ? 'Coding Plan key' : 'API key',
      identity: label([
        storedPlan === 'coding' ? 'GLM Coding Plan key (auth-scoped)' : 'stored key (auth-scoped)',
        maskedKeyTail(storedKey),
      ]),
      active: !envKey,
      envPinned: false,
      signedIn: true,
      ...(envKey ? { stateNote: 'shadowed — the env pin wins' } : {}),
      removal: { route: 'zai-stored-key' },
    })
  }
  return slots
}

function openrouterSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.openrouterEnvKey
    ? reads.openrouterEnvKey()
    : process.env.OPENROUTER_API_KEY?.trim() || undefined
  const minted = (reads.openrouterMintedKey ?? readMintedOpenrouterKey)()
  const storedKey = (reads.openrouterStoredKey ?? readStoredOpenrouterApiKey)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['OPENROUTER_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'OPENROUTER_API_KEY' },
    })
  }
  if (minted) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:oauth-key',
      name: 'oauth',
      kind: 'oauth',
      kindLabel: 'OAuth-minted key',
      identity: label([
        `minted ${new Date(minted.mintedAtMs).toLocaleDateString()}`,
        maskedKeyTail(minted.key),
      ]),
      active: !envKey,
      envPinned: false,
      signedIn: true,
      ...(envKey ? { stateNote: 'shadowed — the env pin wins' } : {}),
      removal: { route: 'openrouter-oauth-key' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: !envKey && !minted,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the env pin wins' }
        : minted
          ? { stateNote: 'shadowed — the OAuth-minted key wins' }
          : {}),
      removal: { route: 'openrouter-stored-key' },
    })
  }
  return slots
}

/** One env-or-stored key-lane family's slots (the zaiSlots shape, shared by
 *  the key-lane families): the env pin always its own slot and the
 *  winner; the stored key shown, shadow-noted when the env pin wins. */
function keyLaneSlots(args: {
  family: string
  envVar: string
  envKey: string | undefined
  storedKey: string | undefined
  storedRemoval: SlotRemoval
}): AccountSlot[] {
  const slots: AccountSlot[] = []
  if (args.envKey) {
    slots.push({
      family: args.family,
      id: `${args.family}:env-key`,
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label([`${args.envVar} (env)`, maskedKeyTail(args.envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: args.envVar },
    })
  }
  if (args.storedKey) {
    slots.push({
      family: args.family,
      id: `${args.family}:stored-key`,
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(args.storedKey)]),
      active: !args.envKey,
      envPinned: false,
      signedIn: true,
      ...(args.envKey ? { stateNote: 'shadowed — the env pin wins' } : {}),
      removal: args.storedRemoval,
    })
  }
  return slots
}

function geminiSlots(reads: AccountSlotReads): AccountSlot[] {
  const oauthConnected = (reads.geminiOauthConnected ?? geminiOauthConnected)()
  const active = (reads.geminiActiveAccount ?? resolveGeminiAccount)()
  const envGoogle = reads.geminiEnvGoogleKey
    ? reads.geminiEnvGoogleKey()
    : process.env.GOOGLE_API_KEY?.trim() || undefined
  const envGemini = reads.geminiEnvGeminiKey
    ? reads.geminiEnvGeminiKey()
    : process.env.GEMINI_API_KEY?.trim() || undefined
  const storedKey = (reads.geminiStoredKey ?? readStoredGeminiApiKey)()
  const slots: AccountSlot[] = []
  if (oauthConnected) {
    slots.push({
      family: 'gemini',
      id: 'gemini:oauth',
      name: 'google',
      kind: 'oauth',
      kindLabel: 'OAuth',
      identity: 'Google account (OAuth)',
      active: active?.kind === 'oauth',
      envPinned: false,
      signedIn: true,
      removal: { route: 'gemini-oauth' },
    })
  }
  if (envGoogle) {
    slots.push({
      family: 'gemini',
      id: 'gemini:env-google-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['GOOGLE_API_KEY (env)', maskedKeyTail(envGoogle)]),
      active: active?.kind === 'api-key' && active.keySource === 'env-google',
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'GOOGLE_API_KEY' },
    })
  }
  if (envGemini) {
    slots.push({
      family: 'gemini',
      id: 'gemini:env-gemini-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['GEMINI_API_KEY (env)', maskedKeyTail(envGemini)]),
      active: active?.kind === 'api-key' && active.keySource === 'env-gemini',
      envPinned: true,
      signedIn: true,
      ...(envGoogle
        ? { stateNote: 'shadowed — GOOGLE_API_KEY wins (the documented precedence)' }
        : {}),
      removal: { route: 'env', envVar: 'GEMINI_API_KEY' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'gemini',
      id: 'gemini:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: active?.kind === 'api-key' && active.keySource === 'stored',
      envPinned: false,
      signedIn: true,
      ...(envGoogle || envGemini ? { stateNote: 'shadowed — an env pin wins' } : {}),
      removal: { route: 'gemini-stored-key' },
    })
  }
  return slots
}

/** The Moonshot family: the env pin, the Kimi sign-in, the stored key — in
 *  the owning resolver's precedence (env > sign-in > stored), each slot
 *  saying what shadows it. */
function moonshotSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.moonshotEnvKey ? reads.moonshotEnvKey() : process.env.MOONSHOT_API_KEY?.trim() || undefined
  const oauth = (reads.moonshotOauth ?? moonshotStoredTokens)()
  const storedKey = (reads.moonshotStoredKey ?? readStoredMoonshotApiKey)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'moonshot',
      id: 'moonshot:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['MOONSHOT_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'MOONSHOT_API_KEY' },
    })
  }
  if (oauth) {
    const region = (reads.moonshotOauthRegion ?? moonshotLoginRegion)()
    // An expired access token with no refresh route cannot dispatch (the
    // resolver drops it at the next call) — the row says so instead of
    // painting a signed-in account the wire would refuse.
    const expiredUnrefreshable =
      oauth.accessTokenExpiresAtMs !== undefined &&
      oauth.accessTokenExpiresAtMs <= Date.now() &&
      !oauth.refreshToken
    slots.push({
      family: 'moonshot',
      id: 'moonshot:oauth',
      name: 'kimi',
      kind: 'oauth',
      kindLabel: 'Kimi sign-in',
      identity: label([
        `Kimi account (device-code sign-in · ${kimiRegionLabel(region)})`,
        maskedKeyTail(oauth.accessToken),
      ]),
      active: !envKey && !expiredUnrefreshable,
      envPinned: false,
      signedIn: !expiredUnrefreshable,
      ...(expiredUnrefreshable
        ? { stateNote: 'access token expired with no refresh route — /logins moonshot signs in again' }
        : envKey
          ? { stateNote: 'shadowed — the env pin wins' }
          : {}),
      removal: { route: 'moonshot-oauth' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'moonshot',
      id: 'moonshot:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: !envKey && !oauth,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the env pin wins' }
        : oauth
          ? { stateNote: 'shadowed — the Kimi sign-in wins' }
          : {}),
      removal: { route: 'moonshot-stored-key' },
    })
  }
  return slots
}

function deepseekSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.deepseekEnvKey ? reads.deepseekEnvKey() : process.env.DEEPSEEK_API_KEY?.trim() || undefined
  const storedKey = (reads.deepseekStoredKey ?? readStoredDeepseekApiKey)()
  return keyLaneSlots({
    family: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    envKey,
    storedKey,
    storedRemoval: { route: 'deepseek-stored-key' },
  })
}

function compatSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.compatEnvKey ? reads.compatEnvKey() : process.env.MERCURY_COMPAT_API_KEY?.trim() || undefined
  const storedKey = (reads.compatStoredKey ?? readStoredCompatApiKey)()
  return keyLaneSlots({
    family: 'openai-compat',
    envVar: 'MERCURY_COMPAT_API_KEY',
    envKey,
    storedKey,
    storedRemoval: { route: 'compat-stored-key' },
  })
}

function huggingfaceSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.huggingfaceEnvKey ? reads.huggingfaceEnvKey() : process.env.HF_TOKEN?.trim() || undefined
  const oauth = (reads.huggingfaceOauth ?? huggingfaceStoredTokens)()
  const storedKey = (reads.huggingfaceStoredKey ?? readStoredHuggingfaceApiKey)()
  const identityOf = reads.huggingfaceStoredKeyIdentity ?? huggingfaceStoredTokenIdentity
  const slots: AccountSlot[] = []
  if (envKey) {
    const identity = identityOf(envKey)
    slots.push({
      family: 'huggingface',
      id: 'huggingface:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'token · env',
      identity: label(['HF_TOKEN (env)', identity?.username, maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'HF_TOKEN' },
    })
  }
  if (oauth) {
    const identity = (reads.huggingfaceOauthIdentity ?? huggingfaceOauthIdentity)()
    // An expired access token with no refresh route cannot dispatch (the
    // resolver drops it at the next call) — the row says so instead of
    // painting a signed-in account the wire would refuse.
    const expiredUnrefreshable =
      oauth.accessTokenExpiresAtMs !== undefined &&
      oauth.accessTokenExpiresAtMs <= Date.now() &&
      !oauth.refreshToken
    slots.push({
      family: 'huggingface',
      id: 'huggingface:oauth',
      name: identity?.username ?? 'hf',
      kind: 'oauth',
      kindLabel: 'OAuth',
      identity: label([
        identity ? `Hugging Face account · ${identity.username}` : 'Hugging Face account (device flow)',
        maskedKeyTail(oauth.accessToken),
      ]),
      active: !envKey && !expiredUnrefreshable,
      envPinned: false,
      signedIn: !expiredUnrefreshable,
      ...(expiredUnrefreshable
        ? { stateNote: 'access token expired with no refresh route — /logins reconnects Hugging Face' }
        : envKey
          ? { stateNote: 'shadowed — the env pin wins' }
          : {}),
      removal: { route: 'huggingface-oauth' },
    })
  }
  if (storedKey) {
    const identity = identityOf(storedKey)
    slots.push({
      family: 'huggingface',
      id: 'huggingface:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'token',
      identity: label(['stored token (auth-scoped)', identity?.username, maskedKeyTail(storedKey)]),
      active: !envKey && !oauth,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the env pin wins' }
        : oauth
          ? { stateNote: 'shadowed — the OAuth sign-in wins' }
          : {}),
      removal: { route: 'huggingface-stored-key' },
    })
  }
  return slots
}

/** Local servers have no login: the discovered servers ARE the identity
 *  (one slot per server, 'signed in' = answering), plus the optional key
 *  slots in the key-lane shape. */
function localSlots(reads: AccountSlotReads): AccountSlot[] {
  const account = (reads.localAccount ?? resolveLocalAccount)()
  const envKey =
    reads.localEnvKey ? reads.localEnvKey() : process.env.MERCURY_LOCAL_API_KEY?.trim() || undefined
  const storedKey = (reads.localStoredKey ?? readStoredLocalApiKey)()
  const slots: AccountSlot[] = []
  if (account) {
    slots.push({
      family: 'local',
      id: 'local:servers',
      name: 'servers',
      kind: 'api-key',
      kindLabel: account.kind === 'keyless' ? 'keyless' : 'key',
      identity: `${account.label} · discovered live`,
      active: true,
      envPinned: false,
      signedIn: true,
      removal: {
        route: 'owner',
        note: 'discovered live — stop the server (or unset MERCURY_LOCAL_BASE_URL) and the row leaves on the next probe',
      },
    })
  }
  slots.push(
    ...keyLaneSlots({
      family: 'local',
      envVar: 'MERCURY_LOCAL_API_KEY',
      envKey,
      storedKey,
      storedRemoval: { route: 'local-stored-key' },
    }),
  )
  return slots
}

/** A family this module has no bespoke owners for: the adapter's OWN account
 *  view (description.account — kind + label, never a secret) is the slot, so
 *  a future catalogue family appears with no edit here or on the board. */
function genericSlots(
  family: ProviderFamilyPresence,
  provider: RouterModelSnapshot['providers'][number] | undefined,
): AccountSlot[] {
  const account = provider?.description.account
  if (!account || account.kind === 'none') return []
  const kind: AccountSlotKind =
    account.kind === 'api-key' || account.kind === 'keyless'
      ? 'api-key'
      : account.kind === 'chatgpt-login'
        ? 'subscription'
        : 'oauth'
  return [
    {
      family: family.id,
      id: `${family.id}:account`,
      name: 'account',
      kind,
      kindLabel: kind === 'api-key' ? 'API key' : kind === 'subscription' ? 'subscription' : 'OAuth',
      identity: account.label,
      active: true,
      envPinned: false,
      signedIn: true,
      removal: {
        route: 'owner',
        note: `the ${family.id} credential lives with its owning store — see /capabilities for the route`,
      },
    },
  ]
}

/**
 * The board model: one group per NON-DARK family the catalogue knows, in
 * catalogue order, each with every signed-in identity as its own slot.
 * File-backed reads throughout — cheap, sync, re-derivable every render.
 */
export function deriveFamilySlotGroups(
  providers: RouterModelSnapshot['providers'] = buildRouterModelSnapshot().providers,
  reads: AccountSlotReads = {},
): FamilySlotGroup[] {
  const presences = providerFamilyPresences(providers, reads.familyReads)
  return presences
    .map(family => {
      const slots =
        family.id === 'anthropic'
          ? anthropicSlots(reads)
          : family.id === 'openai'
            ? openaiSlots(reads)
            : family.id === 'zai'
              ? zaiSlots(reads)
              : family.id === 'openrouter'
                ? openrouterSlots(reads)
                : family.id === 'gemini'
                  ? geminiSlots(reads)
                  : family.id === 'moonshot'
                    ? moonshotSlots(reads)
                    : family.id === 'deepseek'
                      ? deepseekSlots(reads)
                      : family.id === 'openai-compat'
                        ? compatSlots(reads)
                        : family.id === 'huggingface'
                          ? huggingfaceSlots(reads)
                          : family.id === 'local'
                            ? localSlots(reads)
                            : genericSlots(
                            family,
                            providers.find(provider => provider.id === family.id),
                          )
      return { family, slots }
    })
}

// ── Per-slot removal, routed to the owning store ────────────────────────────

/** Injectable owners for provers; production callers pass nothing. */
export interface SlotRemovalOwners {
  disconnectOpenaiSubscription?: () => void
  clearStoredOpenaiKey?: () => void
  clearStoredZaiKey?: () => void
  disconnectOpenrouterOauthKey?: () => void
  clearStoredOpenrouterKey?: () => void
  disconnectGeminiOauth?: () => void
  clearStoredGeminiKey?: () => void
  clearStoredMoonshotKey?: () => void
  disconnectMoonshotOauth?: () => void
  clearStoredDeepseekKey?: () => void
  clearStoredCompatKey?: () => void
  disconnectHuggingfaceOauth?: () => void
  clearStoredHuggingfaceKey?: () => void
  clearStoredLocalKey?: () => void
  /** Default fires the async keychain+config clear without blocking the
   *  keypress (the board repaints from the stores on the next derive). */
  clearManagedAnthropicKey?: () => void
  /** Per-slot anthropic OAuth sign-out (plain sign-out):
   *  best-effort server-side revoke, token-store delete, identity-snapshot
   *  clear, auth-cache reset. Fires async without blocking the keypress. */
  signOutAnthropicOauth?: () => void
  /** Post-disconnect key probe for the honest still-resolves appendix. */
  openaiApiKeyAfter?: () => { key: string; source: 'env' | 'stored' } | undefined
}

/** The default per-slot anthropic OAuth sign-out: server-side revoke first
 *  (a deleted local copy alone leaves a live token on the server — the
 *  /logout law), then the token store, the identity snapshot, and the auth
 *  caches. THIS login only; /logout remains the global everything-verb. */
async function signOutAnthropicOauthDefault(): Promise<void> {
  try {
    const tokens = getClaudeAIOAuthTokens()
    if (tokens?.refreshToken) await revokeOAuthToken(tokens.refreshToken)
  } catch (error) {
    logError(error)
  }
  try {
    // THIS slot's field only: the store is shared with the MCP server
    // sessions, the extension secrets and the trusted-device token, and the
    // whole-store delete is /logout's verb (FN-015 rank 13 — one ⌫ on the
    // board signed every MCP server out and erased every extension secret).
    const removal = removeSecureStorageField('claudeAiOauth')
    if (!removal.success) {
      logError(new Error('the per-slot sign-out could not rewrite the credential store — the Claude login field stays until the store is writable'))
    }
    saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
  } catch (error) {
    logError(error)
  }
  clearOAuthTokenCache()
  resetUserCache()
  // The signed-out account's usage truth goes with it: the window feeders
  // (lane IV — the one usage-truth reset owner).
  try {
    const { resetLimitsForCredentialSwitch } =
      require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    logError(error)
  }
}

/**
 * Remove exactly THIS slot through its owning store. Env-pinned keys are the
 * shell's and are refused with the honest route; the anthropic OAuth slot
 * signs out (tokens + identity only — the home dir is never deleted).
 * Returns the note to show and whether a store changed.
 */
export function executeSlotRemoval(
  slot: AccountSlot,
  owners: SlotRemovalOwners = {},
): { note: string; mutated: boolean } {
  const outcome = routeSlotRemoval(slot, owners)
  if (outcome.mutated) afterCredentialLeft(slot)
  return outcome
}

/**
 * What every removal that MUTATED a store owes the rest of the process:
 * the observations made under the departed credential leave with it (the
 * usage-limit latches are keyed on the family or the source kind, never
 * the credential — a departed account's wall refused work on its
 * successor and its bands painted the successor's meters); a failover
 * handoff whose home was this family has no home left; and the sign-in
 * epoch moves, so every epoch-keyed memo re-reads and every subscribed
 * surface re-derives now — the chip, the composer's account row, the
 * computed default — with no new session. The anthropic window feeders
 * reset on their own sign-out road (resetLimitsForCredentialSwitch).
 */
function afterCredentialLeft(slot: AccountSlot): void {
  forgetFamilyObservations(slot.family, slot.kind)
  try {
    const { clearCapHandoffForFamily } = require('../capFailover.js') as typeof import('../capFailover.js')
    clearCapHandoffForFamily(slot.family)
  } catch {
    /* the decision core is optional here — the removal itself already landed */
  }
  noteCredentialRemoval()
}

/** Forget one family's observed limit state (lazy requires: the latch
 *  modules sit beside the runtimes, above this seam). A store that cannot
 *  answer holds nothing to forget — never a throw. */
function forgetFamilyObservations(family: string, kind: AccountSlotKind): void {
  try {
    switch (family) {
      case 'openai': {
        const { forgetOpenaiLimitSource } =
          require('./openai/openaiLimitState.js') as typeof import('./openai/openaiLimitState.js')
        forgetOpenaiLimitSource(kind === 'api-key' ? 'api-key' : 'chatgpt-subscription')
        return
      }
      case 'openrouter': {
        const { forgetOpenrouterObservedLimit } =
          require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
        forgetOpenrouterObservedLimit()
        return
      }
      case 'gemini': {
        const { forgetGeminiObservedLimit } =
          require('./gemini/geminiUsageState.js') as typeof import('./gemini/geminiUsageState.js')
        forgetGeminiObservedLimit()
        return
      }
      case 'huggingface': {
        const { forgetHuggingfaceObservedLimits } =
          require('./huggingface/huggingfaceUsageState.js') as typeof import('./huggingface/huggingfaceUsageState.js')
        forgetHuggingfaceObservedLimits()
        return
      }
      default:
        return
    }
  } catch {
    /* an observation store that cannot answer holds nothing to forget */
  }
}

/** The per-route removal itself — the switch every engine route has a row
 *  in (the everything-verb below mirrors it row for row). */
function routeSlotRemoval(
  slot: AccountSlot,
  owners: SlotRemovalOwners,
): { note: string; mutated: boolean } {
  const removal = slot.removal
  switch (removal.route) {
    case 'excluded':
    case 'owner':
    case 'settings':
      return { note: removal.note, mutated: false }
    case 'env':
      return {
        note: `${removal.envVar} is the shell's env pin — unset it in your shell to remove; Mercury never edits your environment`,
        mutated: false,
      }
    case 'anthropic-oauth': {
      // Plain per-slot sign-out. The home dir itself is
      // NEVER deleted — only the login (tokens + identity snapshot) leaves;
      // transcripts, config, and the home stay untouched on disk.
      if (!slot.signedIn) {
        return { note: 'not signed in — nothing to sign out (↵ signs in)', mutated: false }
      }
      ;(owners.signOutAnthropicOauth ?? (() => void signOutAnthropicOauthDefault()))()
      return {
        note: 'signing out this Claude login — tokens revoked and dropped; the home, transcripts, and config stay (/logout stays the global verb)',
        mutated: true,
      }
    }
    case 'anthropic-managed-key':
      ;(owners.clearManagedAnthropicKey ?? (() => void removeApiKey()))()
      return { note: 'clearing the /logins managed key (config + keychain)', mutated: true }
    case 'openai-subscription': {
      ;(owners.disconnectOpenaiSubscription ?? disconnectOpenaiSubscription)()
      const key = (owners.openaiApiKeyAfter ?? resolveOpenaiApiKey)()
      return {
        note: `ChatGPT subscription disconnected — tokens dropped.${key ? ` The OpenAI API key (${key.source}) still resolves as the api-key source.` : ''}`,
        mutated: true,
      }
    }
    case 'openai-stored-key':
      ;(owners.clearStoredOpenaiKey ?? (() => writeStoredOpenaiApiKey(null)))()
      return { note: 'stored OpenAI API key cleared from the auth-scoped store', mutated: true }
    case 'zai-stored-key':
      ;(owners.clearStoredZaiKey ?? (() => writeStoredZaiApiKey(null)))()
      return { note: 'stored Z.AI API key cleared from the auth-scoped store', mutated: true }
    case 'openrouter-oauth-key':
      ;(owners.disconnectOpenrouterOauthKey ?? disconnectOpenrouterOauthKey)()
      return {
        note: 'OAuth-minted OpenRouter key dropped locally — revoke it at openrouter.ai → Settings → Keys to kill it server-side',
        mutated: true,
      }
    case 'openrouter-stored-key':
      ;(owners.clearStoredOpenrouterKey ?? (() => writeStoredOpenrouterApiKey(null)))()
      return { note: 'stored OpenRouter API key cleared from the auth-scoped store', mutated: true }
    case 'gemini-oauth':
      ;(owners.disconnectGeminiOauth ?? disconnectGeminiOauth)()
      return {
        note: 'Google OAuth tokens dropped — full revocation lives at myaccount.google.com → Security → Third-party access',
        mutated: true,
      }
    case 'gemini-stored-key':
      ;(owners.clearStoredGeminiKey ?? (() => writeStoredGeminiApiKey(null)))()
      return { note: 'stored Gemini API key cleared from the auth-scoped store', mutated: true }
    case 'moonshot-stored-key':
      ;(owners.clearStoredMoonshotKey ?? (() => writeStoredMoonshotApiKey(null)))()
      return { note: 'stored Moonshot API key cleared from the auth-scoped store', mutated: true }
    case 'moonshot-oauth':
      ;(owners.disconnectMoonshotOauth ?? disconnectMoonshotOauth)()
      return {
        note: 'Kimi sign-in disconnected — tokens dropped (the region choice stays remembered for the next /logins moonshot).',
        mutated: true,
      }
    case 'deepseek-stored-key':
      ;(owners.clearStoredDeepseekKey ?? (() => writeStoredDeepseekApiKey(null)))()
      return { note: 'stored DeepSeek API key cleared from the auth-scoped store', mutated: true }
    case 'compat-stored-key':
      ;(owners.clearStoredCompatKey ?? (() => writeStoredCompatApiKey(null)))()
      return { note: 'stored endpoint API key cleared from the auth-scoped store', mutated: true }
    case 'huggingface-oauth':
      ;(owners.disconnectHuggingfaceOauth ?? disconnectHuggingfaceOauth)()
      return {
        note: 'Hugging Face OAuth tokens dropped — revoke the grant at huggingface.co → Settings → Connected applications to kill it server-side',
        mutated: true,
      }
    case 'huggingface-stored-key':
      ;(owners.clearStoredHuggingfaceKey ?? (() => writeStoredHuggingfaceApiKey(null)))()
      return { note: 'stored Hugging Face token cleared from the auth-scoped store', mutated: true }
    case 'local-stored-key':
      ;(owners.clearStoredLocalKey ?? (() => writeStoredLocalApiKey(null)))()
      return { note: 'stored local-server key cleared from the auth-scoped store', mutated: true }
  }
}

// ── The everything-verb's engine half ───────────────────────────────────────

/**
 * Sign out of EVERY engine family through the SAME owners the per-slot ⌫
 * above fires — the /logout law ("signs out of ALL accounts") made
 * structural: the OAuth stores (the ChatGPT subscription · the OAuth-minted
 * OpenRouter key · the Google, Kimi and Hugging Face sign-ins) and every
 * stored key in the auth-scoped secrets file. Env-pinned keys are the
 * shell's and stay, exactly as the ⌫ route refuses them. One failing store
 * never blocks the next: each owner runs under its own guard. The Anthropic
 * side (revoke · token store · managed key) stays with performLogout's own
 * ladder, which calls this for the rest. Every engine route the removal
 * switch knows has a row here — the prover holds the two lists equal.
 */
export function signOutEveryEngineCredential(owners: SlotRemovalOwners = {}): void {
  const steps: Array<[AccountSlot['removal']['route'], () => void]> = [
    ['openai-subscription', owners.disconnectOpenaiSubscription ?? disconnectOpenaiSubscription],
    ['openai-stored-key', owners.clearStoredOpenaiKey ?? (() => writeStoredOpenaiApiKey(null))],
    ['zai-stored-key', owners.clearStoredZaiKey ?? (() => writeStoredZaiApiKey(null))],
    ['openrouter-oauth-key', owners.disconnectOpenrouterOauthKey ?? disconnectOpenrouterOauthKey],
    ['openrouter-stored-key', owners.clearStoredOpenrouterKey ?? (() => writeStoredOpenrouterApiKey(null))],
    ['gemini-oauth', owners.disconnectGeminiOauth ?? disconnectGeminiOauth],
    ['gemini-stored-key', owners.clearStoredGeminiKey ?? (() => writeStoredGeminiApiKey(null))],
    ['moonshot-oauth', owners.disconnectMoonshotOauth ?? disconnectMoonshotOauth],
    ['moonshot-stored-key', owners.clearStoredMoonshotKey ?? (() => writeStoredMoonshotApiKey(null))],
    ['deepseek-stored-key', owners.clearStoredDeepseekKey ?? (() => writeStoredDeepseekApiKey(null))],
    ['compat-stored-key', owners.clearStoredCompatKey ?? (() => writeStoredCompatApiKey(null))],
    ['huggingface-oauth', owners.disconnectHuggingfaceOauth ?? disconnectHuggingfaceOauth],
    ['huggingface-stored-key', owners.clearStoredHuggingfaceKey ?? (() => writeStoredHuggingfaceApiKey(null))],
    ['local-stored-key', owners.clearStoredLocalKey ?? (() => writeStoredLocalApiKey(null))],
  ]
  for (const [, step] of steps) {
    try {
      step()
    } catch (error) {
      logError(error)
    }
  }
  // The observations made under every departed engine credential leave
  // with it (the per-slot road's own law, applied family-wide). The caller
  // (performLogout) announces the estate's move once, after its own
  // Anthropic teardown.
  for (const [family, kind] of [
    ['openai', 'subscription'],
    ['openai', 'api-key'],
    ['openrouter', 'api-key'],
    ['gemini', 'oauth'],
    ['huggingface', 'oauth'],
  ] as const) {
    forgetFamilyObservations(family, kind)
  }
}

// ============================================================================
//  providers/openai.ts — the native OpenAI RouterProviderAdapter (MERCURY
// replaced the codex-app-server adapter when the external Codex
//  engine retired, decision #9).
//
//  GPT turns run IN-PROCESS on the native Responses transport
//  (services/providers/openai/* — openaiCallModel behind callModelRouter).
//  This adapter reports the ENGINE truth to the route fabric (the native
//  engine path is always on — availability is credential truth alone):
//    - status() self-serves the account-presence probe (local file/env only
//      — primeOpenaiDiscovery, the zai pattern; there is no
//      'discovery-pending' state): 'no-account:openai' until a source is
//      connected, then available:true.
//    - the catalogue is the LIVE qualification owner's cache
//      (openaiCatalogue.ts) when it has been fetched this session, else the
//      official display pins with honest 'static-pin' provenance — STATIC
// PINS NEVER ACTIVATE anything (brief); they are display material.
//    - resolveModel/buildLaunchPatch serve EXPLICITLY-SLOTTED gpt seats
//      (decision #6): the 'gpt' class resolves to the highest-priority
//      QUALIFIED candidate from the live cache — never a static pin, never
//      an invented id. Default seat topology stays Anthropic (no frontier
//      registration — decision).
// ============================================================================
import {
  getCachedOpenaiCatalogue,
  gptDisplayPin,
  qualifiedGptCandidates,
  GPT_DISPLAY_PINS,
} from '../../../services/providers/openai/openaiCatalogue.js'
import { primeOpenaiDiscovery } from '../providerDiscovery.js'
import type {
  ProviderCatalogueEntry,
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
  SpecialistRole,
} from './types.js'
import { SPECIALIST_ROLES } from './types.js'

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

/** Catalogue-verified deprecated/retired ids — a LAST-OBSERVED record
 * an exact-id dispatch naming
 *  one of these refuses LOUDLY, naming the deprecation, instead of sending a
 *  dead id to the wire. Deprecations move with the provider — verify against
 *  the live catalogue before extending this list. */
export const DEPRECATED_GPT_IDS: readonly string[] = [
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
]

/** The active OpenAI account (never a secret) — self-primed on EVERY read,
 *  the sibling adapters' status() law (the probe is local file/env only,
 *  cheap+sync). The one-credential-truth law rides on this: a cache-first
 *  read here served the boot-time record for the rest of the session, so a
 *  /logins sign-in never reached the presence enumeration — /submodels, the
 *  coordinator picker and the engine dispatch gate all kept answering "no
 *  OpenAI account" over a signed-in home (operator repro). */
function activeAccount() {
  const discovery = primeOpenaiDiscovery()
  return discovery?.provider === 'openai' ? discovery.account : undefined
}

/** The display-pin catalogue rows (static provenance — display only). */
function staticPinCatalogue(): ProviderCatalogueEntry[] {
  return GPT_DISPLAY_PINS.map(pin => ({
    id: pin.id,
    displayLabel: pin.displayName,
    modelClass: 'gpt' as const,
    // A pin only states a window where an official fact is recorded — an
    // absent field stays honestly absent (never zero, never invented).
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    // Efforts are LIVE per-model truth — a static pin never invents a
    // vocabulary (empty = not stated here; the live catalogue states it).
    efforts: [],
    roles: ALL_ROLES,
  }))
}

/** Live-cache catalogue rows when a fetch has happened this session. */
function liveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | null {
  const account = activeAccount()
  if (!account) return null
  const snapshot = getCachedOpenaiCatalogue(account.kind)
  if (!snapshot || snapshot.fetchedAtMs === 0) return null
  const entries: ProviderCatalogueEntry[] = []
  for (const candidate of qualifiedGptCandidates('specialist', account.kind)) {
    entries.push({
      id: candidate.identity.canonicalId,
      displayLabel: candidate.displayName,
      modelClass: 'gpt',
      // SOURCE truth first: this is the LIVE catalogue, so the
      // window must be the one the active source actually serves — stamping
      // the static display pin here reported the API model page's 1,050,000
      // over a subscription that live-serves 272,000. The pin stays the
      // fallback for a row the source lists without stating a window.
      ...(candidate.live.contextWindow !== undefined
        ? { contextWindow: candidate.live.contextWindow }
        : candidate.pin && candidate.pin.contextWindow !== undefined
          ? { contextWindow: candidate.pin.contextWindow }
          : {}),
      efforts: candidate.live.supportedReasoningEfforts,
      roles: ALL_ROLES,
    })
  }
  return { entries, fetchedAtMs: snapshot.fetchedAtMs }
}

export function describeOpenaiProvider(): ProviderDescription {
  const account = activeAccount()
  const live = liveCatalogue()
  return {
    transport: 'openai-responses',
    capabilities: [
      'streaming',
      'tool-calls',
      'structured-output',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: ALL_ROLES,
    account: account
      ? {
          kind: account.kind === 'chatgpt-subscription' ? 'chatgpt-login' : 'api-key',
          label: account.label,
        }
      : { kind: 'none', label: 'no OpenAI account source connected' },
    catalogue: live?.entries ?? staticPinCatalogue(),
    catalogueSource: live ? 'live-discovery' : 'static-pin',
    ...(live ? { discoveredAtMs: live.fetchedAtMs } : {}),
  }
}

export function openaiStatus(): RouterProviderStatus {
  // Account presence (self-served local probe — cheap+sync, never network).
  if (!activeAccount()) return { available: false, reason: 'no-account:openai' }
  return { available: true }
}

export function listOpenaiModels(): RouterProviderModel[] {
  if (!openaiStatus().available) return []
  const live = liveCatalogue()
  if (!live) return [] // static pins never activate — an unfetched catalogue offers nothing
  return live.entries.map(entry => ({
    ref: {
      provider: 'openai' as const,
      model: entry.id,
      modelClass: 'gpt' as const,
      effort: 'high' as const,
      // Context from the official pin table when known; 0 = honest unknown,
      // never a guess (the runtime asks the live catalogue at dispatch).
      contextWindow: entry.contextWindow ?? gptDisplayPin(entry.id)?.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveOpenaiModel(
  modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  // Explicitly-slotted gpt seats only (decision #6): the class resolves to
  // the highest-priority QUALIFIED live candidate; anything else is null.
  // Default topology stays Anthropic — the compiler only asks this adapter
  // when a seat was explicitly slotted 'gpt'.
  if (modelClass !== 'gpt') return null
  if (!openaiStatus().available) return null
  const account = activeAccount()
  if (!account) return null
  const head = qualifiedGptCandidates('specialist', account.kind)[0]
  if (!head) return null
  return {
    provider: 'openai',
    model: head.identity.canonicalId,
    modelClass: 'gpt',
    effort: 'high',
    // SOURCE truth first: this is a LIVE-qualified candidate, so the window
    // is the live row's when stated; the last-observed pin is only the
    // fallback, 0 the honest unknown (never invented).
    contextWindow: head.live.contextWindow ?? head.pin?.contextWindow ?? 0,
  }
}

export function buildOpenaiLaunchPatch(ref: RouteModelRef): { model: string; effort: string } {
  // In-process transport: the launch patch is the exact gpt id — the
  // callModel router sends it to the native runtime; effort resolves against
  // the LIVE per-model vocabulary at dispatch (never hardcoded here).
  return { model: ref.model, effort: ref.effort }
}

export const openaiProviderAdapter: RouterProviderAdapter = {
  id: 'openai',
  transport: 'openai-responses',
  status: openaiStatus,
  describe: describeOpenaiProvider,
  listModels: listOpenaiModels,
  resolveModel: resolveOpenaiModel,
  buildLaunchPatch: buildOpenaiLaunchPatch,
}

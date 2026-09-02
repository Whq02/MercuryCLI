// ============================================================================
//  subModelSlots — the two SUB-model containers (Minerva · Console): one
//  resolver and one catalogue derivation for both.
//
//  A container is a standing side-surface that takes its own model:
//    · minerva — the notepad curator (utils/tabula/minerva.ts, both runners);
//    · console — the Helm side-question fork (utils/cockpit/helmConsoleAsk.ts).
//
//  THE CHOICE IS THE OPERATOR'S. Both containers offer
//  the FULL catalogue the main /model picker offers — every family, carriers
//  included — under the same typed row states; no container applies a tier,
//  a serve check, or a family policy of its own. A container is UNSET until
//  the operator pins a row: resolution runs env pin > saved pick > UNSET,
//  and an unset container answers exactly SUB_MODEL_UNSET_HINT to whatever
//  it is asked, spending no model call — the hint IS the reply, painted
//  where the answer would be. A pick persists across sessions through the
//  saved-pick path, validated at write against the live catalogue.
//
//  The harness stamps the ENGINE IDENTITY into each container's prompt
//  (subModelIdentityLine): the resolved model id and wire from this resolver
//  ride the prompt as a fact line, so the model never has to know its own
//  name.
//
//  The catalogue's own Anthropic credential gate reads the SAME presence
//  enumeration this registry holds (threaded into getModelOptions), and a
//  signed-out row carries the catalogue's `unavailable` words verbatim — the
//  /model picker and this picker cannot disagree about why a row is gated.
//  Nothing here re-spells a model id or a family name: rows come from
//  getModelOptions(), families and display names from the routing law,
//  sign-in facts from the provider-family presence enumeration (the same
//  facts /accounts renders).
//
//  Row states are typed, never a silent filter:
//    · selectable — the catalogue offers it and the family holds a credential;
//    · signed-out — the family holds no credential; activating the row is
//      the ROUTE to its attach home (/logins or the key-entry surface);
//    · refused — the owning catalogue's reason verbatim (dispatch wire
//      pending, hidden by the source, not a dispatchable id, …).
//
//  A saved pick is validated at WRITE against the live catalogue and stored
//  only when selectable; at dispatch the resolved id routes to its own
//  provider runtime, whose refusals stay the honest surface — a credential
//  that later disappears is reported by the runtime, never silently
//  substituted away. A wire that carries no schema-forced output format
//  still serves Minerva: its plans are prompted as JSON, decoded tolerantly
//  and post-validated deterministically (utils/tabula/minerva.ts), and an
//  undecodable answer degrades typed with the model named.
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import { connectToBrowseReason, type CatalogueFamily } from '../../services/providers/catalogueGate.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import {
  providerDisplayName,
  declaredRouteOf,
  type CallModelRoute,
} from '../../services/providers/routeLaw.js'
import {
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../../services/providers/providerUsage.js'
import {
  buildRouterModelSnapshot,
  type RouterModelSnapshot,
} from '../router/modelRegistry.js'
import {
  getModelOptions,
  isProviderActionRow,
  stripContext1m,
  type ModelOption,
} from './modelOptions.js'
import { parseUserSpecifiedModel } from './model.js'

export type SubModelContainer = 'minerva' | 'console'

export const SUB_MODEL_CONTAINERS: readonly SubModelContainer[] = ['minerva', 'console']

/** The one line an UNSET container answers with — rendered where the answer
 *  would be, on every surface, without a model call. */
export const SUB_MODEL_UNSET_HINT = 'use /submodels to pin one of the available model catalogues'

/** The registered env pin per container (flagRegistry rows). */
export function subModelEnvVar(container: SubModelContainer): string {
  return container === 'minerva' ? 'MERCURY_MINERVA_MODEL' : 'MERCURY_CONSOLE_MODEL'
}

/** One id per model: aliases resolved, the [1m] context tag folded — the
 *  window is a call-time flavor, never a second identity. */
export function canonicalSubModelId(value: string): string {
  return stripContext1m(parseUserSpecifiedModel(stripContext1m(value.trim())))
}

export type SubModelOrigin = 'env' | 'saved' | 'unset'

/** A pinned container: the model it runs on and where the pin came from. */
export interface SubModelPin {
  origin: 'env' | 'saved'
  model: string
  /** 'unrecognised' = the pinned/saved id matches no family's declaration —
   *  the slot renders the honest word, never a borrowed family. */
  route: CallModelRoute | 'unrecognised'
  /** Present iff origin === 'env' — the pinning var, NAMED (locked axes
   *  render with their origin). */
  envVar?: string
}

/** An unpinned container: no model, and the one line it answers with. */
export interface SubModelUnset {
  origin: 'unset'
  hint: string
}

export type SubModelResolution = SubModelPin | SubModelUnset

/** The container's model, resolved live: env pin > saved pick > UNSET. No
 *  default derives here — an unpinned container has no model and answers
 *  the hint (the ruling: the choice is the operator's). */
export function resolveSubModel(container: SubModelContainer): SubModelResolution {
  const envVar = subModelEnvVar(container)
  const envRaw = flagEnv(envVar)
  if (envRaw !== undefined && envRaw.trim() !== '') {
    const model = canonicalSubModelId(envRaw)
    return { origin: 'env', model, route: declaredRouteOf(model) ?? 'unrecognised', envVar }
  }
  const saved = getGlobalConfig().subModels?.[container]
  if (saved !== undefined && saved.trim() !== '') {
    const model = canonicalSubModelId(saved)
    return { origin: 'saved', model, route: declaredRouteOf(model) ?? 'unrecognised' }
  }
  return { origin: 'unset', hint: SUB_MODEL_UNSET_HINT }
}

/** The console container's model against the session's own: an override is
 *  returned only when the MODEL IDENTITY genuinely differs — an identical
 *  model keeps the side-question fork's cache-hit prefix (the surface's
 *  economy contract), and the session's own window flavor wins on an
 *  identity match. An unset console overrides nothing: it never dispatches
 *  (the caller answers the hint before any fork work). */
export function consoleModelOverride(sessionModel: string): string | undefined {
  const resolved = resolveSubModel('console')
  if (resolved.origin === 'unset') return undefined
  return canonicalSubModelId(sessionModel) === canonicalSubModelId(resolved.model)
    ? undefined
    : resolved.model
}

/** The engine-identity fact line the harness stamps into a container's
 *  prompt: the resolved model id and wire, stated as a fact the model
 *  cannot know on its own. One writer for both containers, so the two
 *  prompts and the /submodels header can never disagree about the engine. */
export function subModelIdentityLine(container: SubModelContainer, pin: SubModelPin): string {
  const name =
    container === 'minerva' ? 'Minerva, the notepad curator' : 'the Console, the side-question assistant'
  return (
    `Engine identity — a fact stamped by the Mercury harness (you cannot know it on your own): ` +
    `you are ${name}, running on model id "${pin.model}" via the ${providerDisplayName(pin.route)} wire. ` +
    `When asked what model you are, answer with exactly that id and wire; never guess another name.`
  )
}

// ── the catalogue derivation (one row set, both containers) ─────────────────

export type SubModelRowState = 'selectable' | 'signed-out' | 'refused'

export interface SubModelEntry {
  kind: 'model' | 'connect'
  /** Canonical model id; for a connect row, the family id (a row identity,
   *  never dispatched). */
  modelId: string
  displayName: string
  /** The row's declared family — 'unrecognised' when no family declares the
   *  id (the honest word; display echoes it, never a borrowed family). */
  source: CallModelRoute | 'unrecognised'
  state: SubModelRowState
  /** The typed reason for 'refused' (the owning catalogue's words verbatim)
   *  and the credential fact for 'signed-out'. */
  reason?: string
  /** The attach home a signed-out activation routes to; `command` absent
   *  when the home is configuration, not a surface (the note says so). */
  connect?: { command?: string; note: string }
  /** The canonical surface's own identity/limits line, verbatim. */
  description?: string
}

export interface SubModelFamily {
  source: CallModelRoute | 'unrecognised'
  label: string
  credentialed: boolean
  /** The owning resolver's display words for the present credential. */
  credentialLabel?: string
}

export interface SubModelRegistry {
  entries: SubModelEntry[]
  /** First-appearance family order over the entries. */
  families: SubModelFamily[]
}

/** The attach home per family — the same routes the /model picker's action
 *  rows and the /accounts board name. An unknown future family routes to
 *  /logins, so it is never silent. */
export function subModelConnectHome(route: CallModelRoute | string): {
  command?: string
  note: string
} {
  switch (route) {
    case 'anthropic':
      return { command: '/logins anthropic', note: 'sign in — /logins' }
    case 'openai':
      return { command: '/logins openai', note: 'sign in — /logins' }
    case 'openrouter':
      return { command: '/logins openrouter', note: 'connect — /logins' }
    case 'gemini':
      return { command: '/logins gemini', note: 'connect — /logins' }
    // The /logins card carries a row per family: a Kimi device-code sign-in
    // (or a Moonshot key), a Z.AI key (general or GLM Coding Plan), a
    // DeepSeek key — each routed with the family pre-focused.
    case 'zai':
      return { command: '/logins zai', note: 'connect — /logins (API key)' }
    case 'moonshot':
      return { command: '/logins moonshot', note: 'sign in — /logins' }
    case 'deepseek':
      return { command: '/logins deepseek', note: 'connect — /logins (API key)' }
    case 'openai-compat':
      return { note: 'MERCURY_COMPAT_BASE_URL configures the endpoint (key optional — /router key compat)' }
    case 'huggingface':
      // The /logins menu carries a Hugging Face row — route with the family
      // pre-focused, like every browser-flow sibling.
      return { command: '/logins huggingface', note: 'sign in — /logins' }
    case 'local':
      // No sign-in exists: a discovered server IS the credential. Routing
      // to /logins here is a dead end — the note names the real remedy.
      return {
        note: 'no sign-in — start a local server (Ollama · LM Studio · vLLM · llama.cpp) or set MERCURY_LOCAL_BASE_URL',
      }
    default:
      return { command: '/logins', note: 'sign in — /logins' }
  }
}

/** Injectable reads for provers; production callers pass nothing. */
export interface SubModelRegistryReads {
  options?: () => ModelOption[]
  presences?: () => ProviderFamilyPresence[]
  providers?: () => RouterModelSnapshot['providers']
}

/** The ONE row set both containers offer: every model row of the main
 *  /model picker, carriers included, with its typed state. The derivation
 *  takes no container — a container-specific row set would be a policy,
 *  and the ruling leaves the choice to the operator. */
export function composeSubModelRegistry(reads: SubModelRegistryReads = {}): SubModelRegistry {
  const providers = (reads.providers ?? (() => buildRouterModelSnapshot().providers))()
  const presences = (reads.presences ?? (() => providerFamilyPresences(providers)))()
  const presenceOf = new Map(presences.map(presence => [presence.id as string, presence]))
  const credentialed = (route: CallModelRoute | 'unrecognised'): boolean =>
    presenceOf.get(route)?.credentialed ?? false

  const entries: SubModelEntry[] = []
  const seen = new Set<string>()
  const options = (
    reads.options ??
    (() => getModelOptions({ anthropicCredentialed: () => credentialed('anthropic') }))
  )()
  for (const option of options) {
    const value = typeof option.value === 'string' ? option.value : null
    // The Default row, the mode sentinels, and the connect/attach ACTION
    // rows stay out: a container pin needs one exact id, and the attach
    // affordance lives on the signed-out rows themselves.
    if (!value || value.startsWith('__')) continue
    if (isProviderActionRow(value)) continue
    const modelId = canonicalSubModelId(value)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const route = declaredRouteOf(modelId) ?? 'unrecognised'
    const description = option.description.length > 0 ? { description: option.description } : {}
    if (!credentialed(route)) {
      const home = subModelConnectHome(route)
      entries.push({
        kind: 'model',
        modelId,
        displayName: option.label,
        source: route,
        state: 'signed-out',
        // The catalogue's own words for the gate when it spelled them (the
        // /model row's `unavailable`), so the two surfaces agree verbatim.
        reason: option.unavailable ?? 'not signed in',
        connect: home,
        ...description,
      })
      continue
    }
    if (option.unavailable !== undefined) {
      entries.push({
        kind: 'model',
        modelId,
        displayName: option.label,
        source: route,
        state: 'refused',
        reason: option.unavailable,
        ...description,
      })
      continue
    }
    entries.push({
      kind: 'model',
      modelId,
      displayName: option.label,
      source: route,
      state: 'selectable',
      ...description,
    })
  }

  // A family the presence enumeration knows but the row walk never met
  // (a live-only or credential-gated catalogue while signed out, an
  // unconfigured endpoint) still shows: one connect row carrying its route —
  // never a hidden family. For the catalogue-gated families the signed-out
  // reason is the ruled sentence (the catalogue-gating law: no request while
  // signed out, and the row says "connect <provider> to browse its models").
  // Availability-refused families keep their honest reason.
  const catalogueGated = new Set<CallModelRoute>(['huggingface', 'openrouter', 'gemini', 'openai'])
  for (const presence of presences) {
    const route = presence.id as CallModelRoute
    if (entries.some(entry => entry.source === route)) continue
    const home = subModelConnectHome(route)
    entries.push({
      kind: 'connect',
      modelId: `connect:${presence.id}`,
      displayName: presence.credentialed
        ? `${providerDisplayName(presence.id)} — no models listed`
        : `${providerDisplayName(presence.id)} — ${home.command !== undefined ? 'sign in' : 'configure'}`,
      source: route,
      state: presence.credentialed ? 'refused' : 'signed-out',
      ...(presence.credentialed
        ? { reason: presence.reason ?? 'no models in the live catalogue' }
        : {
            reason: catalogueGated.has(route)
              ? connectToBrowseReason(route as Exclude<CatalogueFamily, 'local'>)
              : 'not signed in',
            connect: home,
          }),
      description: home.note,
    })
  }

  const families: SubModelFamily[] = []
  for (const entry of entries) {
    if (families.some(family => family.source === entry.source)) continue
    const presence = presenceOf.get(entry.source)
    families.push({
      source: entry.source,
      label: providerDisplayName(entry.source),
      credentialed: presence?.credentialed ?? false,
      ...(presence?.credentialLabel !== undefined
        ? { credentialLabel: presence.credentialLabel }
        : {}),
    })
  }
  return { entries, families }
}

// ── the validated write ─────────────────────────────────────────────────────

export type SubModelSetResult =
  | { ok: true; receipt: string }
  | { ok: false; reason: string }

/** Persist a container pick through the live catalogue: only a selectable
 *  row lands; anything else is refused with its typed reason and the config
 *  stays untouched. `null` clears the saved pick — the container is UNSET
 *  again and answers the hint. */
export function setSubModel(
  container: SubModelContainer,
  modelId: string | null,
  reads: SubModelRegistryReads = {},
): SubModelSetResult {
  const envVar = subModelEnvVar(container)
  const envRaw = flagEnv(envVar)
  if (envRaw !== undefined && envRaw.trim() !== '') {
    return {
      ok: false,
      reason: `${container} is pinned by ${envVar} this session — unset it to pick here`,
    }
  }
  const label = container === 'minerva' ? 'Minerva' : 'Console'
  if (modelId === null) {
    const had = getGlobalConfig().subModels?.[container] !== undefined
    if (had) {
      saveGlobalConfig(config => {
        const next = { ...config.subModels }
        delete next[container]
        return { ...config, subModels: Object.keys(next).length > 0 ? next : undefined }
      })
    }
    return {
      ok: true,
      receipt: `${label} model unset — ${SUB_MODEL_UNSET_HINT}`,
    }
  }
  const wanted = canonicalSubModelId(modelId)
  const entry = composeSubModelRegistry(reads).entries.find(
    candidate => candidate.kind === 'model' && candidate.modelId === wanted,
  )
  if (!entry) return { ok: false, reason: `${wanted} is not in the live catalogue` }
  if (entry.state !== 'selectable') {
    const route = entry.connect !== undefined ? ` · ${entry.connect.note}` : ''
    return { ok: false, reason: `${entry.displayName}: ${entry.reason ?? 'not selectable'}${route}` }
  }
  saveGlobalConfig(config => ({
    ...config,
    subModels: { ...config.subModels, [container]: wanted },
  }))
  return {
    ok: true,
    receipt: `${label} model set to ${entry.displayName} (${providerDisplayName(entry.source)}) — live on the next ${container === 'minerva' ? 'curator pass' : 'side question'}`,
  }
}

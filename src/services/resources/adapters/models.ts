import { MERCURY_VERSION } from '../../../constants/product.js'
import { stampLocal } from '../../../mneme/entryPage.js'
import { BARE_FAMILY_WORDS, bareFamilyWordOfRoute, type BareFamilyWordRow } from '../../../utils/model/bareFamilyWords.js'
import { getModelOptions, isProviderActionRow, stripContext1m, type ModelOption } from '../../../utils/model/modelOptions.js'
import { getContextWindowForModel, modelSupportsEffort } from '../../../utils/model/capabilities.js'
import { operatorModelFacts } from '../../../utils/model/modelOverrides.js'
import { liveCount } from '../../../utils/model/modelPickerGroups.js'
import { selectableEffortLevels } from '../../../utils/effort.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { declaredRouteOf, providerDisplayName } from '../../providers/routeLaw.js'
import { readCataloguesForOtherFamilies } from '../../providers/catalogueOnDemand.js'
import { isProviderDisabled } from '../../providers/disabledProviders.js'
import { presenceIdentityWords, providerFamilyPresences } from '../../providers/providerUsage.js'
import type { ParsedRef, ResourceAdapter, ResourceContext, ResourceResult } from '../contracts.js'
import { configuredCompatEndpoints, resolveCompatAccount } from '../../providers/openaicompat/compatAccounts.js'
import { cachedCompatCatalogue } from '../../providers/openaicompat/compatCatalogue.js'

export const MODELS_REF = 'mercury://models'
export const KNOWN_MODELS_REF = 'mercury://models/known'

export type LiveListFacts =
  | { kind: 'live'; count: number; readAt: string }
  | { kind: 'unread'; error?: string }
  | { kind: 'static'; words: string }

export interface LiveModelRow {
  id: string
  displayName: string
  current?: boolean
  familyWord?: string
  contextWindow?: number
  efforts?: string[]
  unavailable?: string
  liveUnknown?: boolean
}

export interface LiveProviderPage {
  provider: string
  providerName: string
  account: string
  list: LiveListFacts
  knownDefault?: BareFamilyWordRow & { familyWord: string }
  models: LiveModelRow[]
}

export interface LiveModelsReference {
  readAt: string
  providers: LiveProviderPage[]
  notSignedIn: string[]
}

export interface KnownProviderPage {
  provider: string
  providerName: string
  familyWord?: string
  defaultId?: string
  models: BareFamilyWordRow[]
}

export interface KnownModelsReference {
  version: string
  providers: KnownProviderPage[]
}

const SIGN_IN_FAMILIES = ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'xai', 'meta', 'mistral', 'gemini', 'openrouter', 'huggingface', 'nous', 'zen', 'minimax', 'together', 'cohere'] as const

function windowWords(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toString().replace(/\.0$/, '')}M window`
  return `${Math.round(tokens / 1000)}k window`
}

function liveFactsWords(facts: LiveListFacts, models: LiveModelRow[]): string {
  if (facts.kind === 'live') return `live list read ${facts.readAt} (${liveCount(models.map(row => ({ id: row.id, name: row.displayName, group: '', tag: '', gated: row.unavailable !== undefined })))} live)`
  if (facts.kind === 'unread') return `the live list could not be read${facts.error !== undefined ? ` (${facts.error})` : ''}`
  return facts.words
}

async function listFactsOf(route: string, env: NodeJS.ProcessEnv = process.env): Promise<LiveListFacts> {
  const stamp = (ms: number): string => stampLocal(new Date(ms).toISOString())
  const family = bareFamilyWordOfRoute(route)
  if (family !== undefined) {
    const state = family.listState()
    if (state.kind === 'live') return { kind: 'live', count: state.count, readAt: stamp(state.fetchedAtMs) }
    if (state.kind === 'pin') return { kind: 'unread' }
    return { kind: 'unread', ...(state.error !== undefined ? { error: state.error } : {}) }
  }
  switch (route) {
    case 'zen': {
      const { zenCatalogueRows, getCachedZenCatalogue } = await import('../../providers/zen/zenCatalogue.js')
      const { source } = zenCatalogueRows(env)
      if (source.kind === 'live') return { kind: 'live', count: source.count, readAt: stamp(source.fetchedAtMs) }
      const error = getCachedZenCatalogue(env)?.lastError
      return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
    }
    case 'together': {
      const { togetherCatalogueRows, getCachedTogetherCatalogue } = await import('../../providers/together/togetherCatalogue.js')
      const { source } = togetherCatalogueRows(env)
      if (source.kind === 'live') return { kind: 'live', count: source.count, readAt: stamp(source.fetchedAtMs) }
      const error = getCachedTogetherCatalogue(env)?.lastError
      return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
    }
    case 'openai': {
      const [{ getCachedOpenaiCatalogue }, { resolveOpenaiAccount }] = await Promise.all([import('../../providers/openai/openaiCatalogue.js'), import('../../providers/openai/openaiAccounts.js')])
      const account = resolveOpenaiAccount(env)
      const snapshot = account ? getCachedOpenaiCatalogue(account.kind, env) : null
      if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length > 0) return { kind: 'live', count: snapshot.models.length, readAt: stamp(snapshot.fetchedAtMs) }
      return { kind: 'unread', ...(snapshot?.lastError !== undefined ? { error: snapshot.lastError } : {}) }
    }
    case 'gemini': {
      const [{ getCachedGeminiCatalogue }, { resolveGeminiAccount }] = await Promise.all([import('../../providers/gemini/geminiCatalogue.js'), import('../../providers/gemini/geminiAccounts.js')])
      const account = resolveGeminiAccount(env)
      const snapshot = account ? getCachedGeminiCatalogue(account.kind, env) : null
      if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length > 0) return { kind: 'live', count: snapshot.models.length, readAt: stamp(snapshot.fetchedAtMs) }
      return { kind: 'unread', ...(snapshot?.lastError !== undefined ? { error: snapshot.lastError } : {}) }
    }
    case 'openrouter': {
      const [{ getCachedOpenrouterCatalogue }, { resolveOpenrouterAccount }] = await Promise.all([import('../../providers/openrouter/openrouterCatalogue.js'), import('../../providers/openrouter/openrouterAccounts.js')])
      const account = resolveOpenrouterAccount(env)
      const snapshot = account ? getCachedOpenrouterCatalogue(account.keySource, env) : null
      if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length > 0) return { kind: 'live', count: snapshot.models.length, readAt: stamp(snapshot.fetchedAtMs) }
      return { kind: 'unread', ...(snapshot?.lastError !== undefined ? { error: snapshot.lastError } : {}) }
    }
    case 'huggingface': {
      const { getCachedHuggingfaceCatalogue } = await import('../../providers/huggingface/huggingfaceCatalogue.js')
      const snapshot = getCachedHuggingfaceCatalogue(env)
      if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length > 0) return { kind: 'live', count: snapshot.models.length, readAt: stamp(snapshot.fetchedAtMs) }
      return { kind: 'unread', ...(snapshot?.lastError !== undefined ? { error: snapshot.lastError } : {}) }
    }
    case 'nous': {
      const { getCachedNousCatalogue } = await import('../../providers/nous/nousCatalogue.js')
      const snapshot = getCachedNousCatalogue(env)
      if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length > 0) return { kind: 'live', count: snapshot.models.length, readAt: stamp(snapshot.fetchedAtMs) }
      return { kind: 'unread', ...(snapshot?.lastError !== undefined ? { error: snapshot.lastError } : {}) }
    }
    case 'local':
      return { kind: 'static', words: 'the models the local server lists (discovered, not a provider catalogue)' }
    case 'openai-compat':
      return { kind: 'static', words: 'the models the operator named for the endpoint (MERCURY_COMPAT_MODELS)' }
    default:
      return { kind: 'static', words: 'the rows this account offers (no live list to read)' }
  }
}

function routeOfRow(option: ModelOption): string | undefined {
  const bare = stripContext1m(option.value)
  return declaredRouteOf(bare) ?? undefined
}

function rowOf(option: ModelOption, current: string | undefined, familyWordHeads: Map<string, string>): LiveModelRow {
  const id = option.value
  const bare = normalizeModelStringForAPI(id)
  let efforts: string[] | undefined
  try {
    efforts = modelSupportsEffort(bare) ? [...selectableEffortLevels(bare)].map(String) : undefined
  } catch {
    efforts = undefined
  }
  const familyWord = familyWordHeads.get(bare.toLowerCase())
  const contextWindow = operatorModelFacts(bare)?.contextWindow !== undefined ? getContextWindowForModel(bare) : option.statedContextWindow
  return {
    id,
    displayName: option.label,
    ...(current !== undefined && (normalizeModelStringForAPI(current) === bare || current === id) ? { current: true } : {}),
    ...(familyWord !== undefined ? { familyWord } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(efforts !== undefined && efforts.length > 0 ? { efforts } : {}),
    ...(option.unavailable !== undefined ? { unavailable: option.unavailable } : {}),
    ...(option.liveUnknown === true ? { liveUnknown: true } : {}),
  }
}

export async function liveModelsReference(ctx: Pick<ResourceContext, 'engineModel'>, opts?: { boundMs?: number; env?: NodeJS.ProcessEnv }): Promise<LiveModelsReference> {
  const env = opts?.env ?? process.env
  await readCataloguesForOtherFamilies(null, { boundMs: opts?.boundMs ?? 5_000 })
  const presences = providerFamilyPresences().filter(presence => !isProviderDisabled(presence.id))
  const options = getModelOptions().filter(option => !isProviderActionRow(option.value))
  const familyWordHeads = new Map<string, string>()
  for (const entry of BARE_FAMILY_WORDS) {
    if (isProviderDisabled(entry.route)) continue
    const head = entry.headRow() ?? entry.pinnedDefault()
    if (head !== undefined) familyWordHeads.set(head.id.toLowerCase(), entry.word)
  }
  const byRoute = new Map<string, ModelOption[]>()
  for (const option of options) {
    const route = routeOfRow(option)
    if (route === undefined) continue
    byRoute.set(route, [...(byRoute.get(route) ?? []), option])
  }
  const signedIn = presences.filter(presence => presence.credentialed)
  const providers: LiveProviderPage[] = []
  for (const presence of signedIn) {
    const route = presence.id
    if (route === 'openai-compat') {
      const endpoints = configuredCompatEndpoints(env).filter(endpoint => endpoint.named)
      if (endpoints.length > 0) {
        for (const endpoint of endpoints) {
          const cached = cachedCompatCatalogue(endpoint, env)
          const list: LiveListFacts = endpoint.models.length > 0 ? { kind: 'static', words: 'the models named in settings' }
            : cached?.fetchedAtMs ? { kind: 'live', count: cached.models.length, readAt: stampLocal(new Date(cached.fetchedAtMs).toISOString()) }
              : { kind: 'unread', ...(cached?.error ? { error: cached.error } : {}) }
          providers.push({ provider: `openai-compat/${endpoint.name}`, providerName: `${endpoint.label} (${endpoint.name})`, account: resolveCompatAccount(env, endpoint.name)?.label ?? 'keyless endpoint', list,
            models: (byRoute.get(route) ?? []).filter(option => option.value.startsWith(`compat/${endpoint.name}/`)).map(option => rowOf(option, ctx.engineModel, familyWordHeads)) })
        }
        continue
      }
    }
    const list = await listFactsOf(route, env)
    const knownDefault = list.kind === 'live' ? undefined : knownDefaultOf(route)
    providers.push({
      provider: route,
      providerName: providerDisplayName(route),
      account: presenceIdentityWords(presence) ?? presence.credentialLabel ?? 'signed in',
      list,
      ...(knownDefault !== undefined ? { knownDefault } : {}),
      models: (byRoute.get(route) ?? []).map(option => rowOf(option, ctx.engineModel, familyWordHeads)),
    })
  }
  const notSignedIn = presences.filter(presence => !presence.credentialed && (SIGN_IN_FAMILIES as readonly string[]).includes(presence.id)).map(presence => providerDisplayName(presence.id))
  return { readAt: stampLocal(new Date().toISOString()), providers, notSignedIn }
}

import { MODEL_LOOKUP_LADDER, PROVIDER_MODEL_PAGES } from '../../../utils/model/modelLookup.js'

export function liveModelsReferenceText(reference: LiveModelsReference): string {
  const lines: string[] = [
    `providers the operator is signed into and the models each reaches, read live ${reference.readAt} — the same rows /model and /logins show:`,
  ]
  if (reference.providers.length === 0) lines.push('  no provider is signed in — /logins connects one.')
  for (const provider of reference.providers) {
    lines.push('', `${provider.providerName} — ${provider.account} · ${liveFactsWords(provider.list, provider.models)}${provider.knownDefault !== undefined ? ` — the family word '${provider.knownDefault.familyWord}' runs ${provider.knownDefault.displayName} (${provider.knownDefault.id}), the default this build knows, until the list reads` : ''}`)
    if (provider.models.length === 0) lines.push(`  no model row — ${provider.list.kind === 'unread' ? 'nothing is selectable until the list reads; mercury://models/known lists what this build knows' : 'the list serves no model this build can run'}`)
    for (const row of provider.models) {
      const facts = [
        row.displayName !== row.id ? row.displayName : undefined,
        row.current === true ? 'this turn runs on it' : undefined,
        row.familyWord !== undefined ? `the family word '${row.familyWord}' runs this` : undefined,
        row.contextWindow !== undefined ? windowWords(row.contextWindow) : undefined,
        row.efforts !== undefined ? `efforts ${row.efforts.join(' · ')}` : undefined,
        row.liveUnknown === true ? 'listed live, unknown to this build' : undefined,
        row.unavailable !== undefined ? `not selectable: ${row.unavailable}` : undefined,
      ].filter((fact): fact is string => fact !== undefined)
      lines.push(`  ${row.id}${facts.length > 0 ? `  ${facts.join(' · ')}` : ''}`)
    }
  }
  if (reference.notSignedIn.length > 0) lines.push('', `not signed in: ${reference.notSignedIn.join(', ')} — /logins connects one; a model of these runs only after the operator signs in.`)
  lines.push(
    '',
    "Name a model by its id above. A family word (grok, glm, kimi, deepseek, muse, mistral) runs that family's current default. When a provider's list could not be read, mercury://models/known lists what this build knows and the default that runs. " + MODEL_LOOKUP_LADDER,
    '',
    'Published model pages (web text, not account reachability):',
    ...Object.entries(PROVIDER_MODEL_PAGES).map(([provider, url]) => `  ${providerDisplayName(provider)}: ${url}`),
  )
  return lines.join('\n')
}

export async function knownModelsReference(): Promise<KnownModelsReference> {
  const providers: KnownProviderPage[] = []
  const { ALL_MODEL_CONFIGS, FAMILY_GENERATIONS } = await import('../../../utils/model/configs.js')
  const { getMarketingNameForModel } = await import('../../../utils/model/model.js')
  const anthropic: BareFamilyWordRow[] = []
  for (const keys of Object.values(FAMILY_GENERATIONS)) {
    for (const key of keys) {
      const id = (ALL_MODEL_CONFIGS as Record<string, { firstParty: string }>)[key]?.firstParty
      if (id === undefined || anthropic.some(row => row.id === id)) continue
      anthropic.push({ id, displayName: getMarketingNameForModel(id) ?? id })
    }
  }
  providers.push({ provider: 'anthropic', providerName: providerDisplayName('anthropic'), models: anthropic })
  const { GPT_DISPLAY_PINS } = await import('../../providers/openai/gptPins.js')
  providers.push({ provider: 'openai', providerName: providerDisplayName('openai'), familyWord: 'gpt', models: GPT_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName })) })
  for (const entry of BARE_FAMILY_WORDS) {
    const pinned = entry.pinnedDefault()
    providers.push({ provider: entry.route, providerName: providerDisplayName(entry.route), familyWord: entry.word, ...(pinned !== undefined ? { defaultId: pinned.id } : {}), models: entry.knownRows() })
  }
  const { GEMINI_PRICE_PINS } = await import('../../providers/gemini/geminiPins.js')
  providers.push({ provider: 'gemini', providerName: providerDisplayName('gemini'), familyWord: 'gemini', models: GEMINI_PRICE_PINS.map(pin => ({ id: pin.id, displayName: pin.id })) })
  const { HUGGINGFACE_DISPLAY_PINS } = await import('../../providers/huggingface/huggingfacePins.js')
  providers.push({ provider: 'huggingface', providerName: providerDisplayName('huggingface'), familyWord: 'huggingface', models: HUGGINGFACE_DISPLAY_PINS.map(pin => ({ id: `huggingface/${pin.id}`, displayName: pin.displayName })) })
  const { ZEN_DISPLAY_PINS, zenQualifiedId } = await import('../../providers/zen/zenPins.js')
  providers.push({ provider: 'zen', providerName: providerDisplayName('zen'), familyWord: 'zen', models: ZEN_DISPLAY_PINS.map(pin => ({ id: zenQualifiedId(pin.id), displayName: pin.displayName })) })
  const { TOGETHER_DISPLAY_PINS, togetherQualifiedId } = await import('../../providers/together/togetherPins.js')
  providers.push({ provider: 'together', providerName: providerDisplayName('together'), familyWord: 'together', models: TOGETHER_DISPLAY_PINS.map(pin => ({ id: togetherQualifiedId(pin.id), displayName: pin.displayName })) })
  return { version: MERCURY_VERSION, providers }
}

export function knownModelsReferenceText(reference: KnownModelsReference): string {
  const lines: string[] = [
    `what this build knows (Mercury ${reference.version}), not what is reachable now — the pin tables this build ships. mercury://models shows the live lists; a model here runs only when its provider is signed in and its live list names it, or the list could not be read:`,
  ]
  for (const provider of reference.providers) {
    const head = [
      provider.providerName,
      provider.familyWord !== undefined ? `family word '${provider.familyWord}'` : undefined,
      provider.defaultId !== undefined ? `runs ${provider.defaultId} when the live list cannot be read` : undefined,
    ].filter((part): part is string => part !== undefined)
    lines.push('', head.join(' — '))
    for (const row of provider.models) lines.push(`  ${row.id}${row.displayName !== row.id ? `  ${row.displayName}` : ''}`)
  }
  lines.push('', 'Reachability is the live page\'s to say: a signed-in provider whose list reads names its own rows there; this page never says a model is reachable.')
  return lines.join('\n')
}

export function knownDefaultOf(route: string): (BareFamilyWordRow & { familyWord: string }) | undefined {
  const family = bareFamilyWordOfRoute(route)
  const pinned = family?.pinnedDefault()
  return family !== undefined && pinned !== undefined ? { ...pinned, familyWord: family.word } : undefined
}

export const modelsAdapter: ResourceAdapter = {
  kind: 'models',
  describe: 'the model pages: mercury://models — the providers the operator is signed into and the models each reaches, read live (the rows /model and /logins show); mercury://models/known — the models this build knows from its pin tables, not what is reachable now',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') {
      const reference = await liveModelsReference(ctx)
      return {
        state: 'ok',
        resource: {
          ref: MODELS_REF,
          kind: 'models',
          title: 'models reachable now',
          summary: `${reference.providers.length} provider${reference.providers.length === 1 ? '' : 's'} signed in · ${reference.providers.reduce((n, provider) => n + provider.models.length, 0)} model rows · read ${reference.readAt}`,
          mutable: true,
          structured: reference,
          text: liveModelsReferenceText(reference),
          children: [{ ref: KNOWN_MODELS_REF, title: 'models this build knows', summary: 'the pin tables this build ships, not what is reachable now' }],
        },
      }
    }
    if (ref.id === 'known') {
      const reference = await knownModelsReference()
      return {
        state: 'ok',
        resource: {
          ref: KNOWN_MODELS_REF,
          kind: 'models',
          title: 'models this build knows',
          summary: `Mercury ${reference.version} · ${reference.providers.length} providers · ${reference.providers.reduce((n, provider) => n + provider.models.length, 0)} pinned models · not a reachability claim`,
          mutable: false,
          version: reference.version,
          structured: reference,
          text: knownModelsReferenceText(reference),
        },
      }
    }
    return { state: 'absent', note: 'the model pages have two forms: mercury://models (reachable now, read live) and mercury://models/known (what this build knows)' }
  },
  async list(): Promise<{ ref: string; title: string; summary: string }[]> {
    return [
      { ref: MODELS_REF, title: 'models reachable now', summary: 'the providers the operator is signed into and the models each reaches, read live' },
      { ref: KNOWN_MODELS_REF, title: 'models this build knows', summary: 'the pin tables this build ships, not what is reachable now' },
    ]
  },
}

import { formatAge } from '../../utils/healthCertCore.js'

export type ModelListFamily = 'anthropic' | 'openai' | 'zai' | 'moonshot' | 'deepseek' | 'gemini' | 'huggingface'

export interface TypedIdVerdict {
  rows: Array<{ id: string; served: boolean }>
  served: string[]
  notServed: string[]
}

export function judgeTypedIds(
  typed: readonly string[],
  listed: readonly string[],
  current?: (id: string) => string,
): TypedIdVerdict {
  const key = (id: string): string => (current ? current(id) : id).trim().toLowerCase()
  const served = new Set(listed.map(key))
  const rows = typed.map(id => ({ id, served: served.has(key(id)) }))
  return {
    rows,
    served: rows.filter(row => row.served).map(row => row.id),
    notServed: rows.filter(row => !row.served).map(row => row.id),
  }
}

export type ModelListSource =
  | { kind: 'list'; ids: string[]; fetchedAtMs: number }
  | { kind: 'unread'; lastError?: string; lastAttemptAtMs?: number }
  | { kind: 'no-credential' }
  | { kind: 'no-endpoint'; datedAt: string }
  | { kind: 'not-read' }
  | { kind: 'unreadable'; reason: string }

export interface ModelListFact {
  family: ModelListFamily
  name: string
  source?: string
  typed: string[]
  list: ModelListSource
  current?: (id: string) => string
}

export type ModelListsStatus = 'ok' | 'warn' | 'unknown' | 'info'

export interface ModelListsRow {
  status: ModelListsStatus
  evidence: string
  detail: string
  fix?: string
}

export const MODEL_LISTS_FIX = 'pick from the live rows in /model — a typed id the list lacks is refused before the wire; /bug reports the stale ids'
export const MODEL_LISTS_READ_HINT = '/model or a chat naming the family reads it'
export const MODEL_LISTS_UNREAD_EVIDENCE = `no list read in this process — ${MODEL_LISTS_READ_HINT}; the release-day check reads every list`

const NOT_JUDGED = (n: number): string => `${n} typed ${n === 1 ? 'id' : 'ids'} not judged`
const TYPED = (n: number): string => `${n} typed ${n === 1 ? 'id' : 'ids'}`

function isReadable(fact: ModelListFact): boolean {
  return fact.list.kind !== 'no-endpoint' && fact.list.kind !== 'not-read'
}

export function modelListFamilyLines(fact: ModelListFact, nowMs: number): string[] {
  const head = `${fact.name} · ${fact.source ?? 'no credential'}`
  const list = fact.list
  switch (list.kind) {
    case 'list': {
      const verdict = judgeTypedIds(fact.typed, list.ids, fact.current)
      const line = `${head} · served ${verdict.served.length} · not served ${verdict.notServed.length} · list from ${formatAge(nowMs - list.fetchedAtMs)}`
      return verdict.notServed.length === 0 ? [line] : [line, `${fact.name} not served: ${verdict.notServed.join(' · ')}`]
    }
    case 'unread':
      return [
        list.lastError !== undefined
          ? `${head} · the last list read failed${list.lastAttemptAtMs !== undefined ? ` ${formatAge(nowMs - list.lastAttemptAtMs)}` : ''} (${list.lastError}) · ${NOT_JUDGED(fact.typed.length)}`
          : `${head} · no list read in this process — ${MODEL_LISTS_READ_HINT} · ${NOT_JUDGED(fact.typed.length)}`,
      ]
    case 'no-credential':
      return [`${fact.name} · no credential · ${NOT_JUDGED(fact.typed.length)}`]
    case 'no-endpoint':
      return [`${head} · no live list — typed table dated ${list.datedAt} · ${TYPED(fact.typed.length)}`]
    case 'not-read':
      return [`${fact.name} · no list read (Mercury reads no ${fact.name} list; the release-day check does) · ${TYPED(fact.typed.length)}`]
    case 'unreadable':
      return [`${head} · the cached list could not be read (${list.reason}) · ${NOT_JUDGED(fact.typed.length)}`]
  }
}

export function composeModelListsRow(facts: readonly ModelListFact[], nowMs: number): ModelListsRow {
  let served = 0
  let notServed = 0
  let listsRead = 0
  let unread = 0
  let unreadable = 0
  const readable = facts.filter(isReadable).length
  const lacking: string[] = []
  const lines: string[] = []
  for (const fact of facts) {
    lines.push(...modelListFamilyLines(fact, nowMs))
    if (fact.list.kind === 'list') {
      listsRead++
      const verdict = judgeTypedIds(fact.typed, fact.list.ids, fact.current)
      served += verdict.served.length
      notServed += verdict.notServed.length
      if (verdict.notServed.length > 0) lacking.push(fact.name)
    } else if (fact.list.kind === 'unread') unread++
    else if (fact.list.kind === 'unreadable') unreadable++
  }
  const tally = `lists read ${listsRead} of ${readable}`
  const detail = lines.join('\n')
  if (notServed > 0) {
    return {
      status: 'warn',
      evidence: `served ${served} · not served ${notServed} (${lacking.join(', ')}) · ${tally}`,
      detail,
      fix: MODEL_LISTS_FIX,
    }
  }
  if (listsRead > 0) return { status: 'ok', evidence: `served ${served} · not served 0 · ${tally}`, detail }
  if (unreadable > 0) return { status: 'unknown', evidence: `a cached list could not be read · ${tally}`, detail }
  if (unread > 0) return { status: 'info', evidence: `${MODEL_LISTS_UNREAD_EVIDENCE} · ${tally}`, detail }
  return { status: 'info', evidence: `no credential for a family with a live list · ${tally}`, detail }
}

function cachedListSource(snapshot: { models: ReadonlyArray<{ id: string }>; fetchedAtMs: number; lastError?: string; lastAttemptAtMs?: number } | null): ModelListSource {
  if (snapshot === null) return { kind: 'unread' }
  if (snapshot.models.length > 0 || (snapshot.fetchedAtMs > 0 && snapshot.lastError === undefined)) {
    return { kind: 'list', ids: snapshot.models.map(model => model.id), fetchedAtMs: snapshot.fetchedAtMs }
  }
  return {
    kind: 'unread',
    ...(snapshot.lastError !== undefined ? { lastError: snapshot.lastError } : {}),
    ...(snapshot.lastAttemptAtMs !== undefined ? { lastAttemptAtMs: snapshot.lastAttemptAtMs } : {}),
  }
}

function guarded(family: ModelListFamily, name: string, typed: () => string[], read: () => ModelListFact): ModelListFact {
  try {
    return read()
  } catch (error) {
    let ids: string[] = []
    try {
      ids = typed()
    } catch {
      ids = []
    }
    return { family, name, typed: ids, list: { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) } }
  }
}

function anthropicTypedIds(): string[] {
  const model = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
  return [
    ...new Set(
      [model.getDefaultFableModel(), model.getDefaultOpusModel(), model.getDefaultSonnetModel(), model.getDefaultHaikuModel(), model.getSmallFastModel()].map(id =>
        model.normalizeModelStringForAPI(id),
      ),
    ),
  ]
}

function anthropicFact(name: string): ModelListFact {
  return guarded('anthropic', name, anthropicTypedIds, () => {
    const { anthropicCredentialPresence } = require('./providerUsage.js') as typeof import('./providerUsage.js')
    const presence = anthropicCredentialPresence()
    return {
      family: 'anthropic',
      name,
      ...(presence.credentialed ? { source: presence.credentialLabel ?? 'Anthropic credential' } : {}),
      typed: anthropicTypedIds(),
      list: { kind: 'not-read' },
    }
  })
}

function openaiFact(name: string, env: NodeJS.ProcessEnv): ModelListFact {
  const typed = (): string[] => (require('./openai/gptPins.js') as typeof import('./openai/gptPins.js')).GPT_DISPLAY_PINS.map(pin => pin.id)
  return guarded('openai', name, typed, () => {
    const { resolveOpenaiAccount } = require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
    const { getCachedOpenaiCatalogue } = require('./openai/openaiCatalogue.js') as typeof import('./openai/openaiCatalogue.js')
    const account = resolveOpenaiAccount(env)
    if (!account) return { family: 'openai', name, typed: typed(), list: { kind: 'no-credential' } }
    return { family: 'openai', name, source: account.label, typed: typed(), list: cachedListSource(getCachedOpenaiCatalogue(account.kind, env)) }
  })
}

function geminiFact(name: string, env: NodeJS.ProcessEnv): ModelListFact {
  const typed = (): string[] => (require('./gemini/geminiPins.js') as typeof import('./gemini/geminiPins.js')).GEMINI_PRICE_PINS.map(pin => pin.id)
  return guarded('gemini', name, typed, () => {
    const { resolveGeminiAccount } = require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
    const { getCachedGeminiCatalogue } = require('./gemini/geminiCatalogue.js') as typeof import('./gemini/geminiCatalogue.js')
    const account = resolveGeminiAccount(env)
    if (!account) return { family: 'gemini', name, typed: typed(), list: { kind: 'no-credential' } }
    const sourceKind = account.kind === 'oauth' ? 'oauth' : 'api-key'
    return { family: 'gemini', name, source: account.label, typed: typed(), list: cachedListSource(getCachedGeminiCatalogue(sourceKind, env)) }
  })
}

function deepseekFact(name: string, env: NodeJS.ProcessEnv): ModelListFact {
  const pins = (): typeof import('./deepseek/deepseekPins.js') => require('./deepseek/deepseekPins.js') as typeof import('./deepseek/deepseekPins.js')
  const typed = (): string[] => pins().DEEPSEEK_DISPLAY_PINS.map(pin => pin.id)
  return guarded('deepseek', name, typed, () => {
    const { resolveDeepseekAccount } = require('./deepseek/deepseekAccounts.js') as typeof import('./deepseek/deepseekAccounts.js')
    const { getCachedDeepseekCatalogue } = require('./deepseek/deepseekCatalogue.js') as typeof import('./deepseek/deepseekCatalogue.js')
    const current = (id: string): string => pins().deepseekCurrentModelId(id.trim().toLowerCase())
    const account = resolveDeepseekAccount(env)
    if (!account) return { family: 'deepseek', name, typed: typed(), list: { kind: 'no-credential' }, current }
    return { family: 'deepseek', name, source: account.label, typed: typed(), list: cachedListSource(getCachedDeepseekCatalogue(env)), current }
  })
}

function huggingfaceFact(name: string, env: NodeJS.ProcessEnv): ModelListFact {
  const typed = (): string[] =>
    (require('./huggingface/huggingfacePins.js') as typeof import('./huggingface/huggingfacePins.js')).HUGGINGFACE_DISPLAY_PINS.map(pin => pin.id)
  return guarded('huggingface', name, typed, () => {
    const { resolveHuggingfaceAccount } = require('./huggingface/huggingfaceAccounts.js') as typeof import('./huggingface/huggingfaceAccounts.js')
    const { getCachedHuggingfaceCatalogue } = require('./huggingface/huggingfaceCatalogue.js') as typeof import('./huggingface/huggingfaceCatalogue.js')
    const account = resolveHuggingfaceAccount(env)
    if (!account) return { family: 'huggingface', name, typed: typed(), list: { kind: 'no-credential' } }
    return { family: 'huggingface', name, source: account.label, typed: typed(), list: cachedListSource(getCachedHuggingfaceCatalogue(env)) }
  })
}

function keyLaneTable(provider: 'zai' | 'moonshot'): { ids: string[]; datedAt: string } {
  const { keyLanePins } = require('../../utils/model/modelOptions.js') as typeof import('../../utils/model/modelOptions.js')
  const pins = keyLanePins(provider)
  return { ids: pins.map(pin => pin.id), datedAt: pins[0]?.observedAt ?? 'unknown' }
}

function zaiFact(name: string, env: NodeJS.ProcessEnv): ModelListFact {
  const typed = (): string[] => keyLaneTable('zai').ids
  return guarded('zai', name, typed, () => {
    const { resolveZaiDispatch } = require('../../utils/router/providerDiscovery.js') as typeof import('../../utils/router/providerDiscovery.js')
    const table = keyLaneTable('zai')
    const dispatch = resolveZaiDispatch(env)
    return {
      family: 'zai',
      name,
      ...(dispatch ? { source: dispatch.plan === 'coding' ? `GLM Coding Plan key (${dispatch.source})` : `Z.AI API key (${dispatch.source})` } : {}),
      typed: table.ids,
      list: { kind: 'no-endpoint', datedAt: table.datedAt },
    }
  })
}

function moonshotFact(name: string, env: NodeJS.ProcessEnv): ModelListFact {
  const typed = (): string[] => keyLaneTable('moonshot').ids
  return guarded('moonshot', name, typed, () => {
    const { resolveMoonshotAccount } = require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
    const table = keyLaneTable('moonshot')
    const account = resolveMoonshotAccount(env)
    return {
      family: 'moonshot',
      name,
      ...(account ? { source: account.label } : {}),
      typed: table.ids,
      list: { kind: 'no-endpoint', datedAt: table.datedAt },
    }
  })
}

export function readModelListFacts(env: NodeJS.ProcessEnv = process.env): ModelListFact[] {
  const { providerDisplayName } = require('./routeLaw.js') as typeof import('./routeLaw.js')
  const name = (family: ModelListFamily): string => providerDisplayName(family)
  return [
    anthropicFact(name('anthropic')),
    openaiFact(name('openai'), env),
    zaiFact(name('zai'), env),
    moonshotFact(name('moonshot'), env),
    deepseekFact(name('deepseek'), env),
    geminiFact(name('gemini'), env),
    huggingfaceFact(name('huggingface'), env),
  ]
}

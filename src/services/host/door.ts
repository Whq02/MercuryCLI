import type { LlmHostResult, LlmHostRoad } from '../llmHost/index.js'
import { keptVolumes } from './volumes.js'
import { hostShape } from './cluster.js'
import { heavyWeights, hostShortStorageWords, hostSpendSoFar } from './costs.js'
import { HOST_VENDORS, vendorKey, vendorLabel, vendorStorage, vendorKeyNotice, type HostVendorId } from './vendors/client.js'
import { vendorKeyRows } from './vendorKeys.js'
import { bankRowWords, bankState, weightsLine } from './bank.js'
import { BANK_KEYS, type BankActionKind } from './fastLoad.js'
import { LLM_HOST_SEARCH_MIN_CHARS, hostMachineName, hostNoStockWords, hostRunningCountWords, hostVendorKeysWords } from '../../commands/llmhost/words.js'
import { getFocusedSessionConnector } from '../engine-connector/focusedConnector.js'
import { configuredCompatEndpoints, resolveCompatApiKey, isCompatEndpointCredentialed } from '../providers/openaicompat/compatAccounts.js'
import { inspectCompatServer } from '../providers/openaicompat/compatProbe.js'
import { cachedCompatCatalogue, refreshCompatCatalogues, rememberCompatCatalogue } from '../providers/openaicompat/compatCatalogue.js'
import { currentHostRecipes, currentPrivateHostRecipes } from './recipesFile.js'
import { choosePrivateRecipesFile, privateRecipesRow, PRIVATE_RECIPES_ROW } from './privateRecipes.js'
import { HF_OFFLINE_WORDS, HF_SEARCH_PLACEHOLDER, hfRecipeSourceWords, hfRowLabel, huggingFaceHubBase, huggingFaceToken, pickHuggingFaceModel, searchHuggingFace, type DerivedHfRecipe, type HfModel, type HfSearchOutcome } from './hfRecipes.js'
import type { HostRecipe } from './recipes.js'
import type { HostOffer, HostPod, RunpodClient } from './runpod.js'
import { hostRecords, type HostRecord } from './store.js'
import { hostLinkObservations, hostMachineTrouble } from './reliability.js'

type Ask = Parameters<LlmHostRoad>[0]
type Emit = Parameters<LlmHostRoad>[1]
interface DoorBox {
  name: string
  kind: 'this-computer' | 'ssh'
  os: string
  memoryGb: number
  unifiedMemory: boolean
  models?: readonly string[]
  engines: readonly { kind: string; version?: string; port?: number }[]
}
interface DoorVendor extends Pick<RunpodClient, 'offers' | 'watchOffer' | 'create' | 'pods' | 'get' | 'stop' | 'terminate' | 'logs' | 'rateLimitPolicy' | 'shapes'> {
  vendor: string
  label: string
}
interface ModelDoorDeps {
  offers: () => Promise<readonly HostOffer[] | undefined>
  pods: () => Promise<readonly HostPod[] | undefined>
  managedReadErrors?: boolean
  podErrors?: () => readonly string[]
  vendorFaults?: () => readonly { vendor: HostVendorId; parked: boolean }[]
  records: () => readonly HostRecord[]
  road: LlmHostRoad
  connect?: () => Promise<boolean>
  connectVendor?: (vendor: HostVendorId) => Promise<boolean>
  manageKey?: (vendor: HostVendorId) => Promise<boolean>
  boxes?: () => readonly DoorBox[] | Promise<readonly DoorBox[]>
  vendors?: readonly DoorVendor[]
  rentVendor?: (vendor: DoorVendor, offer: HostOffer, ask: Ask, emit: Emit, signal: AbortSignal) => Promise<LlmHostResult>
  startBox?: (box: DoorBox, recipe: HostRecipe, ask: Ask, emit: Emit, signal: AbortSignal) => Promise<LlmHostResult>
  budgetLines?: typeof budgetLines
  qualityWords?: (recipe: HostRecipe) => string
  thinkingWords?: (recipe: HostRecipe) => string
  confirmRental?: Ask
  initialModel?: string
  hfSearch?: (query: string, signal: AbortSignal) => Promise<HfSearchOutcome>
  hfPick?: (model: HfModel, signal: AbortSignal) => Promise<{ ok: true; row: DerivedHfRecipe } | { ok: false; words: string }>
  watch?: (recipe: HostRecipe) => Promise<LlmHostResult | undefined>
  bank?: (action: 'open' | BankActionKind, recipe: HostRecipe) => Promise<LlmHostResult | undefined>
}
type RecipeFacts = HostRecipe & { weightsGb?: number; setup?: { engineMinutes?: number; weightsMinutes?: number; loadMinutes?: number } }
const legacyAsks = new WeakSet<Ask>()
const initialModels = new WeakMap<Ask, string>()
export const isHostDoorReentry = (ask: Ask): boolean => legacyAsks.has(ask)
export const initialDoorModel = (ask: Ask): string | undefined => initialModels.get(ask)
export const modelTitle = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const hourly = (price: number): string => '$' + price.toFixed(2) + '/hr'
const shape = hostShape
const flag = (recipe: HostRecipe, name: string): string | undefined => {
  const at = recipe.flags.indexOf(name)
  return at < 0 ? undefined : recipe.flags[at + 1]
}
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
const context = (recipe: HostRecipe): number | undefined => recipe.contextPerSlot ?? recipe.context
const tokens = (value?: number): string => value === undefined ? 'engine default' : value.toLocaleString('en-US') + ' tokens'
const conversationWords = (recipe: HostRecipe): string => {
  const count = positive(Number(flag(recipe, '--parallel')))
  return count ? count + ' × ' + tokens(context(recipe)) : tokens(context(recipe))
}
function budgetLines(_recipe: HostRecipe, _gpuMemoryGb: number): readonly string[] {
  return []
}
function qualityWords(recipe: HostRecipe): string {
  const variant = recipe.label.split(' · ').slice(1).join(' · ').replace(/^found on Hugging Face · not booted by Mercury · /, '').replace(/^(?:GGUF|safetensors) /, '')
  const bits = /(?:^|[-_])Q(\d+)/.exec(variant)?.[1]
  if (bits) return 'Balanced · ' + bits + '-bit'
  if (variant === 'FP8') return 'Best quality · ' + variant.slice(2) + '-bit FP8'
  if (variant === 'NVFP4') return 'Fast crew · NVFP4'
  return variant || 'Original quality'
}
function thinkingWords(recipe: HostRecipe): string {
  const raw = flag(recipe, '--chat-template-kwargs')
  if (raw) try {
    const value = JSON.parse(raw) as { reasoning_effort?: unknown }
    if (typeof value.reasoning_effort === 'string') return value.reasoning_effort
  } catch {}
  return 'engine default'
}
const requiredMemory = (recipe: HostRecipe): number => positive((recipe as RecipeFacts).weightsGb) ?? recipe.vramGb * recipe.count
const fits = (box: DoorBox, recipe: HostRecipe): boolean => (box.models === undefined || box.models.includes(modelTitle(recipe))) && box.memoryGb >= requiredMemory(recipe)
const boxName = (box: DoorBox): string => box.kind === 'this-computer' ? 'this computer' : box.name
const STAMP_RANK: Readonly<Record<string, number>> = { measured: 0, documented: 1, community: 2, unverified: 3 }
const stampRank = (recipes: readonly HostRecipe[]): number => Math.min(...recipes.map(recipe => STAMP_RANK[recipe.verified.by] ?? 3))
type HfLookup = HfSearchOutcome | { state: 'fetching'; settled: Promise<void> }
function hfSearchMemory(deps: ModelDoorDeps, signal: AbortSignal): { lookup: (query: string) => HfLookup | undefined; pick: (model: HfModel) => Promise<{ ok: true; row: DerivedHfRecipe } | { ok: false; words: string }> } {
  const results = new Map<string, HfSearchOutcome>()
  const inflight = new Map<string, Promise<void>>()
  const search = deps.hfSearch ?? ((query: string, abort: AbortSignal) => searchHuggingFace(query, { signal: abort, base: huggingFaceHubBase(), token: huggingFaceToken() }))
  const pick = deps.hfPick ?? ((model: HfModel, abort: AbortSignal) => pickHuggingFaceModel(model, { signal: abort, base: huggingFaceHubBase(), token: huggingFaceToken() }))
  return {
    lookup: query => {
      if (query.length < LLM_HOST_SEARCH_MIN_CHARS) return undefined
      const ready = results.get(query)
      if (ready) return ready
      let settled = inflight.get(query)
      if (!settled) {
        settled = search(query, signal).then(outcome => { results.set(query, outcome) }, () => { results.set(query, { state: 'offline', words: HF_OFFLINE_WORDS }) }).finally(() => inflight.delete(query))
        inflight.set(query, settled)
      }
      return { state: 'fetching', settled }
    },
    pick: model => pick(model, signal),
  }
}
function rentalSentence(offer: HostOffer, thinking = thinkingWords(offer.recipe)): string {
  return modelTitle(offer.recipe) + ' · ' + shape(offer.recipe) + ' · ' + hourly(offer.price) + (offer.dataCenter ? ' · ' + offer.dataCenter : '') + '\n' + qualityWords(offer.recipe) + ' · ' + conversationWords(offer.recipe) + ' · thinking ' + thinking + '\n' + offer.recipe.diskGb + ' GB disk extra · Runpod bills it per GB-month (runpod.io/pricing). Billing starts now and continues after closing.'
}
export function modelDoorRoad(road: LlmHostRoad, title: string): LlmHostRoad {
  return async (ask, emit, signal) => {
    const linked: Ask = plan => ask(plan)
    initialModels.set(linked, title)
    try { return await road(linked, emit, signal) } finally { initialModels.delete(linked) }
  }
}

export function hostRunModelRows(boxes: readonly DoorBox[] = []): { id: string; name: string; tag: string; ctx: string; group: string; action: true; searchableAction: true }[] {
  const records = hostRecords()
  const endpoints = configuredCompatEndpoints()
  const recipes = currentHostRecipes()
  return [...new Set(recipes.map(modelTitle))].filter(title => !records.some(record => record.status === 'RUNNING' && record.provider && endpoints.some(endpoint => endpoint.name === record.provider) && recipes.some(recipe => recipe.id === record.recipe && modelTitle(recipe) === title))).map(title => ({ id: 'host-run:' + title, name: title, tag: 'run it → /llmhost' + (boxes.some(box => box.kind === 'this-computer' && /darwin|mac/i.test(box.os) && recipes.some(recipe => modelTitle(recipe) === title && fits(box, recipe))) ? ' · run it on this Mac →' : ''), ctx: '', group: 'Run a model', action: true, searchableAction: true }))
}

export function hostEndpointChoice<T extends { id: string; name: string; tag: string; action?: boolean }>(row: T): T[] {
  if (!row.id.startsWith('__mercury_connect__:compat/')) return [row]
  const name = row.id.slice('__mercury_connect__:compat/'.length)
  const endpoint = configuredCompatEndpoints().find(item => item.name === name)
  if (!endpoint || !isCompatEndpointCredentialed(endpoint)) return [row]
  const snapshot = cachedCompatCatalogue(endpoint)
  const retry = { ...row, id: 'host-retry:' + name, searchableAction: true, name: endpoint.label + ' · Retry this server →', tag: snapshot?.error ? 'server is not answering' : 'no models listed', action: true }
  return snapshot?.error
    ? [retry, { ...row, id: 'host-remove:' + name, searchableAction: true, name: endpoint.label + ' · Remove this endpoint →', tag: 'Delete only this endpoint and its stored key; the server is untouched.', action: true }]
    : [retry]
}
export async function removeHostEndpoint(name: string): Promise<string> {
  const endpoint = configuredCompatEndpoints().find(item => item.name === name)
  if (!endpoint) return 'This endpoint is no longer registered.'
  if (!cachedCompatCatalogue(endpoint)?.error) return 'This server is answering or has not been checked. Remove it in /llmhost → A server that’s already running → Remove.'
  try {
    const { removeLlmHostProvider } = await import('../llmHost/index.js')
    removeLlmHostProvider(name)
    return 'Removed custom endpoint ' + name + ' · nothing else changed'
  } catch (error) {
    return 'Could not remove custom endpoint ' + name + ' · ' + String(error)
  }
}
export async function retryHostEndpoint(name: string): Promise<string> {
  const endpoint = configuredCompatEndpoints().find(item => item.name === name)
  if (!endpoint) return 'This endpoint is no longer registered.'
  await refreshCompatCatalogues({ name, force: true })
  const snapshot = cachedCompatCatalogue(endpoint)
  return snapshot?.models.length && !snapshot.error ? endpoint.label + ' · ' + snapshot.models.length + ' models ready' : endpoint.label + ' · server is not answering or lists no models · retry when it is ready; the endpoint is still registered'
}

async function switchRunning(record: HostRecord, recipe: HostRecipe, ask: Ask, signal: AbortSignal): Promise<LlmHostResult | undefined> {
  for (;;) {
    const endpoint = configuredCompatEndpoints().find(row => row.name === record.provider)
    if (!endpoint) return { ok: false, words: 'This machine’s endpoint is no longer registered. Open Machines I’m paying for to resume setup.' }
    try {
      const reading = await inspectCompatServer(endpoint, { key: resolveCompatApiKey(process.env, endpoint.name)?.key, signal })
      const model = reading.models.find(name => name === recipe.model || name === modelTitle(recipe)) ?? (reading.models.length === 1 ? reading.models[0] : undefined)
      if (!model) throw new Error('The registered server is not listing this model.')
      signal.throwIfAborted()
      rememberCompatCatalogue(endpoint, reading)
      const id = 'compat/' + (endpoint.named ? endpoint.name + '/' : '') + model
      const result = await getFocusedSessionConnector().setModel(id)
      return result.state === 'refused'
        ? { ok: false, words: 'Model switch refused: ' + result.detail }
        : { ok: true, model: id, registered: true, words: (result.state === 'queued' ? 'Next turn will use: ' : 'This session’s model: ') + modelTitle(recipe) + ' · machine ' + record.id + ' · no new rental' }
    } catch {
      if (signal.aborted) return
      const choice = await ask({ step: 'door-retry', title: 'Server is not answering', found: 'The registered endpoint for machine ' + record.id + ' could not serve this model. It is still registered; no new rental was made.', willRun: 'Escape closes without changing the model.', rows: [{ value: 'retry', label: 'Retry this server' }, { value: 'back', label: 'Back to the model' }] })
      if (choice !== 'retry') return
    }
  }
}

async function enterRoad(deps: ModelDoorDeps, ask: Ask, emit: Emit, signal: AbortSignal, route?: string, recipe?: HostRecipe, offer?: HostOffer, offers: readonly HostOffer[] = [], vendor?: DoorVendor): Promise<LlmHostResult> {
  let selecting = Boolean(recipe)
  let chosenOffer = offer
  const bridge: Ask = async plan => {
    if (plan.step === 'where' && route) return route
    if (selecting && plan.step === 'rental-vendor') return vendor?.vendor ?? 'runpod'
    if (selecting && plan.step === 'budget') return ''
    if (selecting && plan.step === 'models') return modelTitle(recipe!)
    if (selecting && chosenOffer && plan.step === 'offers') {
      const selected = plan.rows?.find(row => row.label.startsWith(chosenOffer!.recipe.label + ' · ' + shape(chosenOffer!.recipe) + ' · ' + hourly(chosenOffer!.price) + (heavyWeights(chosenOffer!.recipe) ? ' · ' + hostShortStorageWords(chosenOffer!.recipe) : '') + ' · ' + (vendor?.label ?? 'Secure Cloud') + (chosenOffer!.dataCenter ? ' · ' + chosenOffer!.dataCenter : '') + (chosenOffer!.hostingType ? ' · ' + chosenOffer!.hostingType : '')))
      if (!selected) throw new Error('That offer changed. Open the model again for fresh stock and prices; no machine was created.')
      return selected.value
    }
    if (plan.step === 'rent-confirm' && chosenOffer && selecting) {
      if (deps.confirmRental) {
        selecting = false
        chosenOffer = undefined
        return deps.confirmRental(plan)
      }
      const expected = chosenOffer.recipe.label + ' · ' + shape(chosenOffer.recipe) + ' · ' + hourly(chosenOffer.price) + (chosenOffer.dataCenter ? ' · ' + chosenOffer.dataCenter : '') + (chosenOffer.hostingType ? ' · ' + chosenOffer.hostingType : '')
      if (plan.found !== expected) throw new Error('That offer changed. Open the model again for fresh stock and prices; no machine was created.')
      const picked = chosenOffer
      selecting = false
      chosenOffer = undefined
      const disclosure = vendor ? vendor.label + ' · ' + modelTitle(picked.recipe) + ' · ' + shape(picked.recipe) + ' · ' + hourly(picked.price) + (picked.dataCenter ? ' · ' + picked.dataCenter : '') + (picked.hostingType ? ' · ' + picked.hostingType : '') + '\n' + qualityWords(picked.recipe) + ' · ' + conversationWords(picked.recipe) + ' · thinking ' + (deps.thinkingWords ?? thinkingWords)(picked.recipe) + '\n' + vendorStorage(vendor.vendor as HostVendorId) + '\n' + vendorKeyNotice(vendor.vendor as HostVendorId) + '\nBilling starts now and continues after closing. Setup failures pause; Resume or Terminate.' : rentalSentence(picked, (deps.thinkingWords ?? thinkingWords)(picked.recipe))
      return ask({ step: 'door-confirm', title: 'Confirm the rental', found: disclosure, willRun: '', rows: [{ value: 'rent', label: 'Confirm ' + hourly(picked.price) + (vendor ? '' : ' + storage') }, { value: 'cancel', label: 'Cancel' }] })
    }
    if (selecting && plan.step === 'rent-confirm') selecting = false
    return ask(plan)
  }
  legacyAsks.add(bridge)
  try { return await deps.road(bridge, emit, signal) } finally { legacyAsks.delete(bridge) }
}

export function rentDoorVendor(road: LlmHostRoad, vendor: DoorVendor, offer: HostOffer, ask: Ask, emit: Emit, signal: AbortSignal): Promise<LlmHostResult> {
  return enterRoad({ road, confirmRental: ask, offers: async () => [offer], pods: async () => [], records: () => [] }, ask, emit, signal, 'rent', offer.recipe, offer, [offer], vendor)
}

export async function runModelDoor(ask: Ask, emit: Emit, signal: AbortSignal, deps: ModelDoorDeps): Promise<LlmHostResult> {
  const stopped = (): LlmHostResult => ({ ok: false, words: 'Kept things as they are.' })
  let title = deps.initialModel
  const search = hfSearchMemory(deps, signal)
  let query = ''
  let notice = ''
  door: while (!signal.aborted) {
    let offerError = ''
    let podError = ''
    const [offers, pods, boxes] = await Promise.all([
      deps.offers().catch(() => { offerError = 'Runpod stock could not be read'; return undefined }),
      deps.pods().catch(() => { podError = 'Paid pods could not be read'; return undefined }),
      Promise.resolve(deps.boxes?.() ?? []),
    ])
    podError ||= deps.podErrors?.().join(' · ') ?? ''
    const vendorErrors = new Map<string, string>()
    const vendors = deps.vendors ?? []
    const vendorOffers = (await Promise.all(vendors.map(async vendor => {
      try { return (await vendor.offers(signal)).map(offer => ({ vendor, offer })) }
      catch { vendorErrors.set(vendor.vendor, vendor.label + ' stock could not be read. Retry; the other vendors are still shown.'); return [] }
    }))).flat()
    const allOffers = [...(offers ?? []), ...vendorOffers.map(row => row.offer)]
    const recipes = currentHostRecipes()
    const privateFile = currentPrivateHostRecipes()
    const privateIds = new Set(privateFile.recipes.map(row => row.id))
    if (privateFile.errors.length) notice = [notice, ...privateFile.errors].filter(Boolean).join('\n')
    const records = deps.records()
    const endpoints = configuredCompatEndpoints()
    const running = records.filter(record => record.status === 'RUNNING' && record.provider && endpoints.some(endpoint => endpoint.name === record.provider) && (pods === undefined || pods.some(pod => pod.id === record.id && pod.status === 'RUNNING')))
    const runningFor = (model: string) => running.filter(record => recipes.some(recipe => recipe.id === record.recipe && modelTitle(recipe) === model))
    const stockVendors = [...(offers === undefined ? [] : [vendorLabel('runpod')]), ...vendors.filter(row => !vendorErrors.has(row.vendor)).map(row => row.label)]
    const groups = [...new Set(recipes.map(modelTitle))].map(name => {
      const variants = recipes.filter(recipe => modelTitle(recipe) === name)
      const live = runningFor(name)[0]
      const own = boxes.find(box => variants.some(recipe => fits(box, recipe)))
      const cheapest = allOffers.filter(offer => modelTitle(offer.recipe) === name).sort((a, b) => a.price - b.price)[0]
      const cheapestVendor = vendorOffers.find(row => row.offer === cheapest)?.vendor.label ?? 'Runpod'
      const runningRecipe = live && recipes.find(recipe => recipe.id === live.recipe)
      const stamp = stampRank(variants)
      const derived = variants.every(recipe => recipe.verified.by === 'unverified' && recipe.id.startsWith('hf-'))
      const where = (live && runningRecipe ? 'running on ' + hostMachineName(live.vendor ?? 'runpod', live.id) + ' · ' + hourly(live.price) + ' · ' + conversationWords(runningRecipe) + ' — switch →'
        : own ? 'fits ' + boxName(own) + ' (' + own.memoryGb + ' GB) — start here →'
        : cheapest ? cheapestVendor + ' ' + shape(cheapest.recipe) + ' · ' + hourly(cheapest.price) + ' · in stock'
        : offers === undefined ? 'Runpod · ' + (offerError ? 'stock unavailable · retry →' : 'connect →') : hostNoStockWords(stockVendors))
      const sourceWords = variants.every(recipe => Boolean(hfRecipeSourceWords(recipe))) ? hfRecipeSourceWords(variants[0]!) : undefined
      return { name, variants, where: (variants.some(row => privateIds.has(row.id)) ? 'private · ' : '') + where, sourceWords, derived, stamp, rank: live ? 0 : own ? 1 : cheapest ? 2 : 3, price: cheapest?.price ?? Infinity }
    }).sort((a, b) => a.rank - b.rank || a.price - b.price || a.stamp - b.stamp || Number(Boolean(a.sourceWords)) - Number(Boolean(b.sourceWords)) || a.name.localeCompare(b.name))
    if (!title) {
      const paid = pods ?? []
      const incomplete = pods === undefined || Boolean(podError)
      const spend = hostSpendSoFar(paid)
      const verified = groups.filter(group => !group.derived)
      const nameWidth = Math.max(0, ...verified.map(group => group.name.length))
      const faults = new Map((deps.vendorFaults?.() ?? []).map(row => [row.vendor, row.parked]))
      const keyVendors = HOST_VENDORS.filter(id => id !== 'huggingface').map(id => ({ label: vendorLabel(id), connected: Boolean(vendorKey(id)), ...(faults.has(id) ? { fault: faults.get(id) ? 'key' as const : 'read' as const } : {}) }))
      const account = [
        { value: 'pods', label: incomplete ? 'Machines I’m paying for →' : 'Machines I’m paying for · ' + paid.length + hostRunningCountWords(paid.filter(pod => pod.status === 'RUNNING').length) + ' · ~$' + spend.toFixed(2) + ' so far + storage' + (keptVolumes().some(row => row.state !== 'gone') ? ' + weights disks' : '') },
        ...(deps.manageKey ? [{ value: 'keys', label: hostVendorKeysWords(keyVendors) }] : []),
      ]
      const also = [{ value: 'boxes', label: '────────────────────\nMy computers · ' + boxes.length }, { value: 'bank', label: 'Bank · your weights' }, { value: 'refresh', label: 'Refresh stock and prices' }, { value: 'other', label: 'More options →' }]
      for (;;) {
        const live = search.lookup(query)
        const models = live?.state === 'ready' ? live.models : []
        const hfWidth = Math.max(0, ...models.map(model => model.id.length))
        const heading = 'HUGGING FACE · ' + models.length + ' result' + (models.length === 1 ? '' : 's')
        const note = live?.state === 'fetching' ? 'HUGGING FACE · fetching…' : live?.state === 'offline' ? 'HUGGING FACE · ' + live.words : live?.state === 'ready' && !models.length ? 'HUGGING FACE · no results for “' + query + '”' : undefined
        const pending = ask({ step: 'door-models', title: 'Which model?', found: '', willRun: [notice, ...deps.managedReadErrors ? [] : [offerError, podError, ...vendorErrors.values()]].filter(Boolean).join(' · '), initial: verified[0]?.name, search: { placeholder: HF_SEARCH_PLACEHOLDER, query, ...(note ? { note } : {}) }, rows: [...account, ...verified.map(group => ({ value: group.name, label: group.name.padEnd(nameWidth) + ' · ' + (group.sourceWords ? group.sourceWords + ' · ' : '') + group.where, section: 'MODELS' })), ...models.map(model => ({ value: 'hf:' + model.id, label: hfRowLabel(model, hfWidth), section: heading })), ...also] })
        notice = ''
        const choice = live?.state === 'fetching' ? await Promise.race([pending, live.settled.then(() => undefined)]) : await pending
        if (choice === undefined) continue
        if (choice === null) return stopped()
        if (choice.startsWith('search:')) { query = choice.slice(7).trim(); continue }
        if (choice === 'refresh') continue door
        if (choice === 'other') return enterRoad(deps, ask, emit, signal)
        if (choice === 'pods') return enterRoad(deps, ask, emit, signal, 'pods')
        if (choice === 'keys' && deps.manageKey) {
          const picked = await ask({ step: 'door-keys', title: 'Vendor keys', found: '', willRun: '', rows: [
            ...vendorKeyRows(),
            ...HOST_VENDORS.filter(id => id !== 'huggingface' && !vendorKey(id) && (id === 'runpod' ? deps.connect : deps.connectVendor)).map(id => ({ value: 'connect:' + id, label: 'Connect ' + vendorLabel(id) + ' →' })),
            { value: 'back', label: 'Back to models' },
          ] })
          if (!picked || signal.aborted) return stopped()
          if (picked.startsWith('key:')) { await deps.manageKey(picked.slice(4) as HostVendorId); continue door }
          if (picked.startsWith('connect:')) { const id = picked.slice(8) as HostVendorId; await (id === 'runpod' ? deps.connect?.() : deps.connectVendor?.(id)); continue door }
          continue
        }
        if (choice === 'boxes') return enterRoad(deps, ask, emit, signal, 'ssh')
        if (choice === 'bank') return enterRoad(deps, ask, emit, signal, 'fast-load')
        if (choice.startsWith('hf:')) {
          const model = models.find(row => row.id === choice.slice(3))
          if (!model) continue
          const picked = await search.pick(model)
          if (signal.aborted) return stopped()
          if (!picked.ok) { notice = picked.words; continue }
          title = modelTitle(picked.row.recipe)
          continue door
        }
        if (!groups.some(group => group.name === choice)) return stopped()
        title = choice
        break
      }
    }
    const group = groups.find(group => group.name === title)
    if (!group) return { ok: false, words: 'That model no longer has a recipe. Open /llmhost for the current models.' }
    const qualityKey = (row: HostRecipe): string => row.label.split(' · ').slice(1).join(' · ')
    const variants = [...new Set(group.variants.map(qualityKey))].map(key => {
      const candidates = group.variants.filter(row => qualityKey(row) === key)
      return allOffers.filter(offer => candidates.some(row => row.id === offer.recipe.id)).sort((a, b) => a.price - b.price)[0]?.recipe ?? candidates[0]!
    }).sort((a, b) => Number(b.verified.by === 'measured') - Number(a.verified.by === 'measured'))
    let recipe = variants.find(row => row.id === runningFor(title!)[0]?.recipe) ?? variants.find(row => allOffers.some(offer => offer.recipe.id === row.id)) ?? variants[0]!
    for (;;) {
      const modelOffers = offers?.filter(offer => modelTitle(offer.recipe) === title && qualityKey(offer.recipe) === qualityKey(recipe)).sort((a, b) => a.price - b.price) ?? []
      const observations = hostLinkObservations()
      const rentals = [...modelOffers.map(offer => ({ vendor: undefined as DoorVendor | undefined, offer })), ...vendorOffers.filter(row => modelTitle(row.offer.recipe) === title && qualityKey(row.offer.recipe) === qualityKey(recipe)).map(row => ({ vendor: row.vendor as DoorVendor | undefined, offer: row.offer }))]
        .map(row => ({ ...row, trouble: hostMachineTrouble((row.vendor?.vendor ?? 'runpod') as HostVendorId, row.offer, observations) }))
        .sort((a, b) => a.trouble.rank - b.trouble.rank || a.offer.price - b.offer.price)
      const live = runningFor(title)
      const quality = deps.qualityWords ?? qualityWords
      const bank = bankState(recipe)
      const facts = ['QUALITY · ' + quality(recipe) + ' · ' + shape(recipe), 'CONVERSATIONS × CONTEXT · ' + conversationWords(recipe), 'THINKING · ' + (deps.thinkingWords ?? thinkingWords)(recipe) + ' · /effort', 'WEIGHTS · ' + weightsLine(recipe, bank)].join('\n')
      const connected = offers !== undefined || vendors.length > 0
      const choice = await ask({ step: 'door-model', title, found: facts, willRun: '', initial: live.length ? 'running:0' : undefined, keys: BANK_KEYS.map(row => row.key === 'b' && bank.banked ? { ...row, label: 'bank again' } : row), rows: [
        ...live.map((record, i) => ({ value: 'running:' + i, label: 'Already running · ' + record.id + ' · switch' })),
        ...rentals.map((row, i) => ({ value: 'rent:' + i, label: 'Rent · ' + (row.vendor?.label ?? 'Runpod') + ' ' + shape(row.offer.recipe) + ' · ' + hourly(row.offer.price) + (row.offer.dataCenter ? ' · ' + row.offer.dataCenter : '') + (row.offer.hostingType ? ' · ' + row.offer.hostingType : '') + (row.offer.machineId ? ' · machine ' + row.offer.machineId : '') })),
        ...boxes.map((box, i) => ({ value: 'box:' + i, label: boxName(box) + (box.models && !box.models.includes(modelTitle(recipe)) ? ' · no local recipe for this model' : fits(box, recipe) ? ' · fits (' + box.memoryGb + ' GB) — start here →' : ' · too small: ' + box.memoryGb + ' GB, needs ' + requiredMemory(recipe).toLocaleString('en-US', { maximumFractionDigits: 1 })) })),
        { value: 'bank', label: bankRowWords(recipe, bank) },
        ...(connected ? [{ value: 'watch', label: rentals.length ? 'Watch stock' : 'No stock · watch' }] : []),
        ...(offers === undefined ? deps.managedReadErrors && offerError ? [] : [{ value: 'connect', label: offerError ? 'Runpod stock could not be read · Retry →' : 'Connect Runpod →' }] : modelOffers.length ? [] : [{ value: 'retry:runpod', label: 'Runpod · no stock for this quality · Refresh →' }]),
        ...(deps.connectVendor ? HOST_VENDORS.filter(id => id !== 'runpod' && !vendors.some(row => row.vendor === id)).map(id => ({ value: 'connect:' + id, label: 'Connect ' + vendorLabel(id) + ' →' })) : []),
        ...vendors.filter(row => !(deps.managedReadErrors && vendorErrors.has(row.vendor)) && (vendorErrors.has(row.vendor) || !vendorOffers.some(item => item.vendor === row && modelTitle(item.offer.recipe) === title && qualityKey(item.offer.recipe) === qualityKey(recipe)))).map(row => ({ value: 'retry:' + row.vendor, label: vendorErrors.get(row.vendor) ?? row.label + ' · no stock for this quality · Refresh →' })),
        ...(deps.manageKey ? vendorKeyRows() : []),
        ...(variants.length > 1 ? [{ value: 'quality', label: 'Choose quality →' }] : []),
        ...(privateIds.has(recipe.id) ? [privateRecipesRow(privateFile)] : []),
        { value: 'back', label: 'Back to models' },
      ] })
      if (!choice || signal.aborted) return stopped()
      if (choice === PRIVATE_RECIPES_ROW) {
        const loaded = await choosePrivateRecipesFile(ask, signal)
        if (!loaded) return stopped()
        notice = loaded; title = undefined
        continue door
      }
      if (choice === 'back') { title = undefined; break }
      if (choice.startsWith('key:') && deps.manageKey) { await deps.manageKey(choice.slice(4) as HostVendorId); break }
      if (choice === 'connect') { if (offerError || await deps.connect?.()) break; continue }
      if (choice.startsWith('connect:') && deps.connectVendor) { if (await deps.connectVendor(choice.slice(8) as HostVendorId)) break; continue }
      if (choice.startsWith('retry:')) break
      if (choice === 'quality') {
        const selected = await ask({ step: 'door-quality', title: 'Choose quality · ' + title, found: '', willRun: '', initial: recipe.id, rows: variants.map(row => ({ value: row.id, label: quality(row) + ' · ' + shape(row) + ' · ' + tokens(context(row)) })) })
        if (!selected) return stopped()
        recipe = variants.find(row => row.id === selected) ?? recipe
        continue
      }
      if (choice.startsWith('running:')) {
        const record = live[Number(choice.slice(8))]
        if (!record) continue
        const result = await switchRunning(record, recipes.find(row => row.id === record.recipe)!, ask, signal)
        if (result) return result
        continue
      }
      if (choice.startsWith('rent:')) {
        const row = rentals[Number(choice.slice(5))]
        if (!row) continue
        if (!row.vendor) return enterRoad(deps, ask, emit, signal, 'rent', row.offer.recipe, row.offer, offers)
        if (deps.rentVendor) return deps.rentVendor(row.vendor, row.offer, ask, emit, signal)
        emit({ title: 'Rental unavailable', words: 'This vendor has no connected rental service. Nothing was rented.' })
        continue
      }
      if (choice === 'watch') {
        if (!deps.watch) return enterRoad(deps, ask, emit, signal, 'rent', recipe)
        const result = await deps.watch(recipe)
        if (result) return result
        continue
      }
      if (choice === 'bank' || BANK_KEYS.some(row => choice.startsWith(row.value + ':'))) {
        const action = choice === 'bank' ? 'open' : choice.slice(0, choice.indexOf(':')) as BankActionKind
        if (!deps.bank) { emit({ title: 'Bank', words: 'The bank is not available here. Nothing was changed.' }); continue }
        const result = await deps.bank(action, recipe)
        if (result) return result
        continue
      }
      if (choice.startsWith('box:')) {
        const box = boxes[Number(choice.slice(4))]
        if (!box || !fits(box, recipe)) continue
        if (deps.startBox) return deps.startBox(box, recipe, ask, emit, signal)
        if (box.kind === 'ssh') return enterRoad(deps, ask, emit, signal, 'ssh')
        emit({ title: 'This computer', words: 'Local startup is not available for this recipe yet. Nothing was started.' })
      }
    }
  }
  return stopped()
}

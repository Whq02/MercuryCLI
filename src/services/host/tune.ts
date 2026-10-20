import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { LLM_HOST_WORDS as words } from '../../commands/llmhost/words.js'
import type { LlmHostRoad } from '../llmHost/index.js'
import { registerHostWindow } from '../llmHost/index.js'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { inspectCompatServer, invalidateLlamacppTotalSlots } from '../providers/openaicompat/compatProbe.js'
import { rememberCompatCatalogue } from '../providers/openaicompat/compatCatalogue.js'
import type { HostRecipe } from './recipes.js'
import { currentHostRecipes, hostRecipeOfRecord } from './recipesFile.js'
import type { HostOffer } from './runpod.js'
import { hostDirectory, patchHostRecord, type HostRecord } from './store.js'
import { hostRunner, inspectSsh, restartHostScript, sshArguments, waitHostEngine, type HostRunner } from './ssh.js'

const preferenceSchema = z.object({ quality: z.string(), conversations: z.number().int().positive().nullable(), contextPerConversation: z.number().int().positive().nullable(), effort: z.enum(['max', 'high', 'medium', 'low', 'default']), updatedAt: z.string().datetime() })
export type HostTunePreferences = z.infer<typeof preferenceSchema>
type Ask = Parameters<LlmHostRoad>[0]
type Emit = Parameters<LlmHostRoad>[1]
export const ENGINE_ALLOWANCE_GB = 12
const titleOf = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const tokens = (n: number): string => n >= 1048576 && n % 1048576 === 0 ? n / 1048576 + 'M' : n % 1024 === 0 ? n / 1024 + 'k' : String(n)
const about = (n: number): string => n >= 1048576 ? (n / 1048576).toFixed(1).replace(/\.0$/, '') + 'M' : Math.floor(n / 1024) + 'k'
const gb = (n: number): string => n.toFixed(1).replace(/\.0$/, '')
const rate = (n: number): string => '$' + n.toFixed(2) + '/hr'
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
const flag = (recipe: HostRecipe, name: string): string | undefined => { const at = recipe.flags.indexOf(name); return at < 0 ? undefined : recipe.flags[at + 1] }

export function qualityWords(recipe: HostRecipe): string {
  const variant = recipe.label.split(' · ').slice(1).join(' · ')
  const table: [RegExp, string][] = [[/^(?:UD-)?Q4(?:_|$)/i, 'Balanced · 4-bit (recommended)'], [/^FP8$/i, 'Best quality · 8-bit FP8'], [/^NVFP4$/i, 'Fast crew · NVFP4']]
  return table.find(([pattern]) => pattern.test(variant))?.[1] ?? (variant || recipe.label)
}

export function defaultTune(recipe: HostRecipe): HostTunePreferences {
  const conversations = Number(flag(recipe, recipe.engine === 'llamacpp' ? '--parallel' : '--max-running-requests')) || null
  const contextPerConversation = (recipe.contextPerSlot ?? recipe.context ?? (recipe.engine === 'llamacpp' && conversations ? Number(flag(recipe, '--ctx-size')) / conversations : Number(flag(recipe, '--context-length')))) || null
  let effort: HostTunePreferences['effort'] = recipe.engine === 'llamacpp' ? 'max' : 'default'
  try { const parsed = preferenceSchema.shape.effort.safeParse(JSON.parse(flag(recipe, '--chat-template-kwargs') ?? '{}').reasoning_effort); if (parsed.success) effort = parsed.data } catch {}
  return { quality: recipe.id, conversations, contextPerConversation, effort, updatedAt: new Date().toISOString() }
}

export function tuneSummary(prefs: HostTunePreferences, recipe: HostRecipe): string {
  return (prefs.conversations ?? 'engine default') + ' × ' + (prefs.contextPerConversation ? tokens(prefs.contextPerConversation) : 'context unknown') + ' · ' + qualityWords(recipe).replace(' (recommended)', '') + ' · ' + prefs.effort
}

export function readTunePreferences(modelTitle: string): HostTunePreferences | undefined {
  try { const file: unknown = JSON.parse(readFileSync(join(hostDirectory(), 'preferences.json'), 'utf8')); const parsed = z.record(z.string(), z.unknown()).parse(file); return preferenceSchema.safeParse(parsed[modelTitle]).data } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Host preferences could not be read: ' + String(error)) }
}

function saveTunePreferences(modelTitle: string, prefs: HostTunePreferences): void {
  const path = join(hostDirectory(), 'preferences.json')
  let previous: Record<string, unknown> = {}
  try { previous = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  durableAtomicPublishSync(path, JSON.stringify({ ...previous, [modelTitle]: preferenceSchema.parse({ ...prefs, updatedAt: new Date().toISOString() }) }) + '\n', { mode: 0o600 })
}

export interface TuneCandidate {
  conversations: number | null
  contextPerConversation: number | null
  totalTokens?: number
  requiredGb?: number
  needsCount?: number
  fits: boolean
  measured: boolean
  label: string
  offer?: HostOffer
}

export function tuneBudget(recipe: HostRecipe, gpuMemoryGb: number, count: number, offers: readonly HostOffer[] = []): { weightsGb?: number; kvBytesPerToken?: number; totalTokens?: number; words: string; candidates: TuneCandidate[] } {
  const defaults = defaultTune(recipe)
  const weightsGb = positive(recipe.weightsGb) ? recipe.weightsGb : undefined
  const kv = recipe.kvBytesPerToken
  const cacheMatches = recipe.engine !== 'llamacpp' || ['--cache-type-k', '--cache-type-v'].every(name => flag(recipe, name) === kv?.cacheType)
  const known = weightsGb !== undefined && positive(kv?.bytes) && kv?.verified.by !== 'unverified' && cacheMatches && gpuMemoryGb > ENGINE_ALLOWANCE_GB && Number.isSafeInteger(count) && count > 0
  const stateGb = (conversations: number | null): number => (conversations ?? 1) * (kv?.conversationBytes ?? 0) / 1e9
  const measuredTotal = defaults.conversations && defaults.contextPerConversation ? defaults.conversations * defaults.contextPerConversation : undefined
  const capacity = known ? Math.max(0, Math.floor(((gpuMemoryGb - ENGINE_ALLOWANCE_GB) * count - weightsGb! - stateGb(defaults.conversations)) * 1e9 / kv!.bytes)) : undefined
  const memory = count + '× ' + recipe.gpu + ' · ' + gpuMemoryGb + ' GB/GPU'
  const words = !known ? memory + ' · ' + (weightsGb === undefined ? 'weights size unknown' : 'context memory unknown') + ' — Mercury cannot promise what fits'
    : memory + ' · weights ' + gb(weightsGb!) + ' GB · ' + ENGINE_ALLOWANCE_GB + ' GB/GPU engine allowance'
  const splits: Array<[number | null, number | null]> = known && recipe.engine === 'llamacpp'
    ? [[1, 1048576], [2, 524288], [4, 262144], [4, 131072], [8, 65536], [8, 131072], [4, 524288], [8, 1048576]] : [[defaults.conversations, defaults.contextPerConversation]]
  if (!splits.some(([n, ctx]) => n === defaults.conversations && ctx === defaults.contextPerConversation)) splits.push([defaults.conversations, defaults.contextPerConversation])
  const candidates = splits.filter(([, ctx]) => !known || ctx === null || ctx <= kv!.maxContext).map(([conversations, contextPerConversation]): TuneCandidate => {
    const totalTokens = conversations && contextPerConversation ? conversations * contextPerConversation : undefined
    const requiredGb = known && totalTokens ? weightsGb! + totalTokens * kv!.bytes / 1e9 + stateGb(conversations) + count * ENGINE_ALLOWANCE_GB : undefined
    const needsCount = requiredGb !== undefined ? Math.max(recipe.count, Math.ceil((requiredGb - count * ENGINE_ALLOWANCE_GB) / (gpuMemoryGb - ENGINE_ALLOWANCE_GB))) : undefined
    const measured = known && recipe.verified.by === 'measured' && gpuMemoryGb >= recipe.vramGb && count >= recipe.count && conversations !== null && defaults.conversations !== null && conversations <= defaults.conversations && totalTokens !== undefined && measuredTotal !== undefined && totalTokens <= measuredTotal
    const fits = !known || measured || needsCount !== undefined && needsCount <= count
    const offer = offers.filter(row => row.recipe.id === recipe.id && row.recipe.count >= (needsCount ?? count)).sort((a, b) => a.price - b.price)[0]
    const split = (conversations ?? 'engine default') + ' × ' + (contextPerConversation ? tokens(contextPerConversation) : 'context unknown')
    const verdict = !known ? 'recipe default only' + (!conversations || !contextPerConversation ? ' · limit not documented for this recipe' : '') : measured ? 'measured to fit' : fits ? 'should fit (estimate)' : 'needs ' + needsCount + '× ' + recipe.gpu + ' (estimate)'
    const use = conversations === 4 && contextPerConversation === 131072 ? ' · lead + 3 crew (recommended)' : conversations === 1 ? ' · one long session' : ''
    return { conversations, contextPerConversation, totalTokens, requiredGb, needsCount, fits, measured, offer, label: split + ' — ' + verdict + (offer ? ' · ' + rate(offer.price) : '') + use }
  })
  return { weightsGb, kvBytesPerToken: known ? kv!.bytes : undefined, totalTokens: capacity, words, candidates }
}

export function tunedRecipe(recipe: HostRecipe, prefs: HostTunePreferences): HostRecipe {
  preferenceSchema.parse(prefs)
  if (prefs.quality !== recipe.id) throw new Error('The tune names different weights.')
  const candidate = tuneBudget(recipe, recipe.vramGb, recipe.count).candidates.find(row => row.conversations === prefs.conversations && row.contextPerConversation === prefs.contextPerConversation && row.fits)
  if (!candidate) throw new Error('This tune is outside the known memory budget. Open Tune again.')
  if (recipe.engine !== 'llamacpp') return recipe
  if (prefs.effort === 'default') throw new Error('Choose an explicit llama.cpp thinking effort.')
  if (!prefs.conversations || !prefs.contextPerConversation || !Number.isSafeInteger(prefs.conversations * prefs.contextPerConversation)) throw new Error('The recipe has no known conversation window.')
  const flags = [...recipe.flags]
  const set = (name: string, value: string): void => { const at = flags.indexOf(name); if (at >= 0) flags.splice(at, 2, name, value); else flags.push(name, value) }
  set('--ctx-size', String(prefs.conversations * prefs.contextPerConversation))
  set('--parallel', String(prefs.conversations))
  const kwargs = JSON.parse(flag(recipe, '--chat-template-kwargs') ?? '{}') as Record<string, unknown>
  set('--chat-template-kwargs', JSON.stringify({ ...kwargs, reasoning_effort: prefs.effort }))
  return { ...recipe, flags, context: prefs.contextPerConversation, contextPerSlot: prefs.contextPerConversation }
}

export async function runTune(modelTitle: string, options: { recipes: readonly HostRecipe[]; offers?: readonly HostOffer[]; pod?: HostRecord; runner?: HostRunner; signal?: AbortSignal; pauseMs?: number; timeoutMs?: number }, ask: Ask, emit: Emit): Promise<HostTunePreferences | undefined> {
  const recipes = options.recipes.filter(row => titleOf(row) === modelTitle)
  if (!recipes.length) throw new Error('No recipes for ' + modelTitle)
  const saved = options.pod?.tune ?? readTunePreferences(modelTitle)
  let recipe = recipes.find(row => row.id === saved?.quality) ?? recipes[0]!
  const signal = options.signal ?? new AbortController().signal
  const question: Ask = plan => signal.aborted ? Promise.resolve(null) : ask(plan)
  const summary = (row: HostRecipe): string => tuneBudget(row, row.vramGb, row.count, options.offers).words
  const quality = await question({ step: 'tune-quality', title: 'QUALITY · ' + modelTitle, found: summary(recipe), willRun: options.pod ? 'Different quality applies at the next rental · no download now · esc closes' : 'Choose weights · no changes until Confirm · esc closes', initial: recipe.id, rows: recipes.map(row => {
    const cheapest = options.offers?.filter(offer => offer.recipe.id === row.id).sort((a, b) => a.price - b.price)[0]
    const context = defaultTune(row).contextPerConversation
    return { value: row.id, label: qualityWords(row) + ' · ' + row.verified.by + ' · ' + row.count + '× ' + row.gpu + (cheapest ? ' · from ' + rate(cheapest.price) : ' · price unavailable') + (context ? ' · ' + tokens(context) + '/conversation' : ' · context unknown') }
  }) })
  if (!quality) return
  recipe = recipes.find(row => row.id === quality)!
  if (!recipe) throw new Error(words.inputError)
  const previous = saved?.quality === recipe.id ? saved : defaultTune(recipe)
  const hardware = options.pod?.target && recipe.id === options.pod.recipe ? await inspectSsh(options.pod.target, options.runner ?? hostRunner, signal) : undefined
  const count = hardware?.gpus.length ?? recipe.count
  const memory = hardware ? Math.min(...hardware.gpus.map(gpu => gpu.memory)) : recipe.vramGb
  const budget = tuneBudget(recipe, memory, count, options.offers)
  const initial = budget.candidates.findIndex(row => row.conversations === previous.conversations && row.contextPerConversation === previous.contextPerConversation)
  const choice = await question({ step: 'tune-context', title: 'CONVERSATIONS × CONTEXT', found: budget.words, willRun: (budget.totalTokens === undefined ? (!previous.conversations || !previous.contextPerConversation ? 'limit not documented for this recipe' : recipe.verification) : budget.totalTokens < 1024 ? 'no room for context beside the weights' : 'room for about ' + about(budget.totalTokens) + ' tokens in all, up to ' + tokens(recipe.kvBytesPerToken!.maxContext) + ' each') + ' · esc closes', initial: String(Math.max(0, initial)), rows: budget.candidates.map((row, index) => ({ value: String(index), label: row.label })) })
  if (choice === null) return
  const candidate = budget.candidates[Number(choice)]
  if (!candidate || !candidate.fits) { emit({ title: 'Tune', words: candidate?.label ?? words.inputError }); return }
  const effort = await question({ step: 'tune-thinking', title: 'THINKING · change any time with /effort', found: budget.words, willRun: recipe.verification + ' · esc closes', initial: recipe.engine === 'llamacpp' ? previous.effort : 'default', rows: recipe.engine === 'llamacpp' ? ['max', 'high', 'medium', 'low'].map(value => ({ value, label: value + (value === 'max' ? ' (recommended)' : '') })) : [{ value: 'default', label: 'default · /effort changes it per request' }] })
  if (!effort) return
  const prefs = preferenceSchema.parse({ quality, conversations: candidate.conversations, contextPerConversation: candidate.contextPerConversation, effort, updatedAt: new Date().toISOString() })
  const inPlace = options.pod?.recipe === recipe.id && recipe.engine === 'llamacpp'
  const confirm = await question({ step: 'tune-confirm', title: 'Confirm tune · ' + modelTitle, found: budget.words, willRun: tuneSummary(prefs, recipe), rows: [{ value: 'confirm', label: inPlace ? 'Confirm · reload in place (~3 min), no download or new pod' : options.pod ? 'Confirm · applies at the next rental · no download now' : 'Confirm · save for the next rental' }, { value: 'cancel', label: words.cancel }] })
  if (confirm !== 'confirm' || signal.aborted) return
  if (inPlace) {
    const result = await retuneHostEngine(options.pod!, prefs, options.runner ?? hostRunner, { signal, pauseMs: options.pauseMs, timeoutMs: options.timeoutMs, emit })
    if (!result.ok) { emit({ title: 'Tune failed', words: result.words }); return }
  }
  saveTunePreferences(modelTitle, prefs)
  emit({ title: 'Tune', words: modelTitle + ' · ' + tuneSummary(prefs, recipe) + (inPlace ? ' · ready' : ' · saved for next rental; no pod changed') })
  return prefs
}

export async function confirmTunedRental(initial: HostOffer, offers: readonly HostOffer[], budget: number | undefined, ask: Ask, emit: Emit, signal: AbortSignal): Promise<HostOffer | undefined> {
  const title = titleOf(initial.recipe)
  let offer = initial
  for (;;) {
    const saved = readTunePreferences(title)
    if (saved) {
      const preferred = offers.find(row => row.recipe.id === saved.quality && row.dataCenter === offer.dataCenter) ?? offers.find(row => row.recipe.id === saved.quality)
      if (!preferred) { emit({ title: 'Tune', words: 'Saved quality has no stock. Choose another quality in Tune; no pod created.' }) }
      else offer = preferred
    }
    const prefs = saved?.quality === offer.recipe.id ? saved : defaultTune(offer.recipe)
    let refusal = saved && !offers.some(row => row.recipe.id === saved.quality) ? 'Saved quality has no stock; choose another quality in Tune.' : ''
    try { tunedRecipe(offer.recipe, prefs) } catch (error) { refusal = String(error) }
    const recipe = offer.recipe
    const context = prefs.contextPerConversation
    const confirm = await ask({ step: 'rent-confirm', title: words.rentalConfirm, found: recipe.label + ' · ' + recipe.count + '× ' + recipe.gpu + ' · ' + rate(offer.price) + (offer.dataCenter ? ' · ' + offer.dataCenter : '') + (budget ? ' · ~' + (budget / offer.price).toFixed(1) + 'h for $' + budget : ''), willRun: refusal || recipe.verified.by + ' · ' + recipe.verification + ' · ' + (context ? context.toLocaleString('en-US') + ' context · ' : '') + tuneSummary(prefs, recipe) + ' · ' + recipe.diskGb + ' GB disk (extra). Billing starts now.', rows: [{ value: 'tune', label: 'Tune: ' + tuneSummary(prefs, recipe) + ' — change' }, ...(refusal ? [] : [{ value: 'rent', label: 'Confirm ' + rate(offer.price) + ' + storage · create this pod' }]), { value: 'cancel', label: words.cancel }] })
    if (signal.aborted) return
    if (confirm === 'tune') { await runTune(title, { recipes: currentHostRecipes(), offers, signal }, ask, emit); continue }
    if (confirm !== 'rent') return
    if (refusal) continue
    saveTunePreferences(title, prefs)
    return offer
  }
}

const retuning = new Set<string>()
export async function retuneHostEngine(record: HostRecord, prefs: HostTunePreferences, runner: HostRunner, options: { signal?: AbortSignal; pauseMs?: number; timeoutMs?: number; emit?: Emit } = {}): Promise<{ ok: boolean; words: string }> {
  if (retuning.has(record.id)) return { ok: false, words: 'This pod is already reloading.' }
  const recipe = hostRecipeOfRecord(record)
  if (!recipe || recipe.engine !== 'llamacpp' || !record.target || !record.provider) return { ok: false, words: 'A registered llama.cpp pod with an SSH target is required; no pod changed.' }
  const signal = options.signal ?? new AbortController().signal
  const next = tunedRecipe(recipe, prefs)
  const oldPrefs = record.tune ?? defaultTune(recipe)
  let changed = false
  retuning.add(record.id)
  try {
    patchHostRecord(record.id, { step: 'reloading engine in place', retuning: true, advancedAt: Date.now() })
    options.emit?.({ title: 'Tune', words: titleOf(recipe) + ' retuned: ' + tuneSummary(prefs, recipe) + ' · reloading ~3 min' })
    changed = true
    await restartHostScript(record.target, next, runner, signal, false)
    await waitHostEngine(record.target, next, runner, signal, options.pauseMs ?? 3000, options.timeoutMs ?? 10 * 60_000)
    const props = JSON.parse(await runner.run('ssh', [...sshArguments(record.target), 'curl -fsS --max-time 10 http://127.0.0.1:30000/props'], signal)) as { default_generation_settings?: { n_ctx?: number }; total_slots?: number }
    if (props.default_generation_settings?.n_ctx !== prefs.contextPerConversation || props.total_slots !== prefs.conversations) throw new Error('The engine returned a different context or conversation count.')
    const endpoint = configuredCompatEndpoints().find(row => row.name === record.provider)
    if (!endpoint) throw new Error('The registered provider no longer exists.')
    invalidateLlamacppTotalSlots(endpoint)
    const reading = await inspectCompatServer(endpoint, { signal })
    if (!reading.models.length || reading.models.some(id => reading.contextWindows[id] !== prefs.contextPerConversation)) throw new Error('The registered tunnel does not report the requested window.')
    registerHostWindow(reading.models.map(id => `compat/${endpoint.named ? endpoint.name + '/' : ''}${id}`), prefs.contextPerConversation!)
    rememberCompatCatalogue(endpoint, reading)
    patchHostRecord(record.id, { tune: prefs, step: 'ready', retuning: false, error: undefined })
    return { ok: true, words: titleOf(recipe) + ' retuned · ready' }
  } catch (error) {
    let restored = !changed
    let healthy = false
    let rollbackError = ''
    if (changed) {
      const recovery = new AbortController().signal
      try {
        await restartHostScript(record.target, recipe, runner, recovery, true)
        restored = true
        await waitHostEngine(record.target, recipe, runner, recovery, options.pauseMs ?? 3000, options.timeoutMs ?? 10 * 60_000)
        healthy = true
        const endpoint = configuredCompatEndpoints().find(row => row.name === record.provider)
        if (endpoint) { invalidateLlamacppTotalSlots(endpoint); const reading = await inspectCompatServer(endpoint, { signal: recovery }); rememberCompatCatalogue(endpoint, reading); if (oldPrefs.contextPerConversation) registerHostWindow(reading.models.map(id => `compat/${endpoint.named ? endpoint.name + '/' : ''}${id}`), oldPrefs.contextPerConversation) }
      } catch (failure) { rollbackError = ' · ' + String(failure) }
    }
    const message = 'Tune failed: ' + String(error) + ' · ' + (restored ? 'old flags restored' + (healthy ? '; previous engine healthy' : '; server did not come back') : 'old flags could not be restored; backup kept on pod') + rollbackError
    patchHostRecord(record.id, { retuning: false, step: healthy ? 'ready' : 'engine reload failed', error: message })
    return { ok: false, words: message }
  } finally { retuning.delete(record.id) }
}

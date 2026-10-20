import { randomUUID } from 'node:crypto'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { LLM_HOST_DIALECTS, LLM_HOST_WORDS as words, hostReplyWords, hostWindowWords } from '../../commands/llmhost/words.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import { ModelFactsSchema } from '../../utils/settings/modelFacts.js'
import { COMPAT_ENDPOINT_NAME, CompatEndpointSchema, CompatProviderSchema, type CompatEndpointSettings } from '../../utils/settings/compatProvider.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { sessionThinkingConfig } from '../../utils/thinking.js'
import { bumpCatalogueEpoch } from '../providers/catalogueEpoch.js'
import { compatKeyEnvName, configuredCompatEndpoints, resolveCompatApiKey, type CompatEndpoint } from '../providers/openaicompat/compatAccounts.js'
import { cachedCompatCatalogue, rememberCompatCatalogue, refreshCompatCatalogues } from '../providers/openaicompat/compatCatalogue.js'
import { compatCallModel } from '../providers/openaicompat/compatCallModel.js'
import { storeCompatApiKeyLogin } from '../providers/openaicompat/compatLogin.js'
import { CompatProbeError, compatServerBase, inspectCompatServer, type CompatDialect, type CompatServerReading } from '../providers/openaicompat/compatProbe.js'
import { writeStoredCompatApiKey } from '../providers/providerSecrets.js'
import { hostModelEfforts } from '../providers/openaicompat/compatEffort.js'

export interface LlmHostQuestion {
  step: string
  title: string
  found: string
  willRun: string
  lines?: string[]
  rows?: ReadonlyArray<{ value: string; label: string }>
  initial?: string
  secret?: boolean
  fullDetails?: boolean
}
export interface LlmHostEvent { title: string; words: string; host?: { id: string; price: number; startedAt: string; status: string; step?: string; canResume?: boolean } }
export interface LlmHostResult { ok: boolean; words: string; model?: string; reply?: string; elapsedMs?: number; registered?: boolean }
type LlmHostAsk = (question: LlmHostQuestion) => Promise<string | null>
export type LlmHostRoad = (ask: LlmHostAsk, emit: (event: LlmHostEvent) => void, signal: AbortSignal) => Promise<LlmHostResult>

function editable(): void {
  if (['flagSettings', 'policySettings'].some(source => getSettingsForSource(source as 'flagSettings' | 'policySettings')?.compatProvider !== undefined)) throw new Error('compatProvider is controlled by launch or policy settings; user settings cannot replace it.')
}

function endpointMap(block: unknown): Record<string, CompatEndpointSettings> {
  const parsed = CompatProviderSchema().parse(block ?? {})
  return CompatEndpointSchema().safeParse(parsed).success
    ? (typeof parsed.baseUrl === 'string' ? { default: parsed as CompatEndpointSettings } : {})
    : parsed as Record<string, CompatEndpointSettings>
}

function writeEndpoint(name: string, endpoint: CompatEndpointSettings | undefined, existing?: CompatEndpoint): void {
  editable()
  if (existing && JSON.stringify(configuredCompatEndpoints().find(endpoint => endpoint.name === name)) !== JSON.stringify(existing)) throw new Error('The provider changed while this screen was open. Open /llmhost again.')
  const result = updateSettingsForSource('userSettings', raw => {
    const block = raw.compatProvider ?? getGlobalConfig().compatProvider
    const map = endpointMap(block)
    if (!existing && map[name]) throw new Error(`Provider '${name}' already exists; choose a different name.`)
    if (existing && JSON.stringify(map[name]) !== JSON.stringify(endpointMap(getSettingsForSource('userSettings')?.compatProvider ?? getGlobalConfig().compatProvider)[name])) throw new Error('The provider changed while this screen was open. Open /llmhost again.')
    const next = { ...map }
    if (endpoint) next[name] = endpoint
    else delete next[name]
    const previous = typeof raw.compatProvider === 'object' && raw.compatProvider !== null ? raw.compatProvider as Record<string, unknown> : {}
    const patch: Record<string, unknown> = Object.fromEntries(Object.keys(previous).map(key => [key, undefined]))
    for (const [key, value] of Object.entries(next)) patch[key] = key === name && typeof previous[key] === 'object' && previous[key] !== null
      ? { ...Object.fromEntries(Object.keys(previous[key] as object).map(field => [field, undefined])), ...value } : value
    return { compatProvider: patch as NonNullable<ReturnType<typeof getSettingsForSource>>['compatProvider'] }
  })
  if (result.error) throw result.error
  bumpCatalogueEpoch()
}
export function registerHostWindow(models: readonly string[], contextWindow: number): void {
  editable()
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error('The server did not report a valid context window.')
  const result = updateSettingsForSource('userSettings', raw => {
    const previous = ModelFactsSchema().parse(raw.models ?? {})
    return { models: { ...previous, ...Object.fromEntries(models.map(id => [id, { ...previous[id], contextWindow }])) } }
  })
  if (result.error) throw result.error
  bumpCatalogueEpoch()
}


async function checkLlmHostReply(model: string, signal: AbortSignal): Promise<LlmHostResult> {
  const started = performance.now()
  let reply = ''
  let fault: string | undefined
  let outputTokens: number | undefined
  let settled = false
  for await (const event of compatCallModel({
    messages: [createUserMessage({ content: words.replyPrompt })],
    systemPrompt: asSystemPrompt([words.replySystem]),
    thinkingConfig: sessionThinkingConfig(), tools: [], signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, agents: [], hasAppendSystemPrompt: false, mcpTools: [], ownerKey: `llmhost:${randomUUID()}`, getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) {
    if (event.type !== 'assistant') continue
    const text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (event.isApiErrorMessage) fault = text
    else { reply += text; outputTokens = event.message.usage.output_tokens; settled = event.message.stop_reason === 'end_turn' }
  }
  const elapsedMs = performance.now() - started
  if (signal.aborted) return { ok: false, model, registered: true, words: words.stopped }
  if (fault || !reply.trim() || !settled) return { ok: false, model, reply, elapsedMs, registered: true, words: `${words.failed} · ${fault || words.empty}` }
  return { ok: true, model, reply, elapsedMs, registered: true, words: hostReplyWords(model, reply, elapsedMs, outputTokens) }
}

export const runLlmHost: LlmHostRoad = async (ask, emit, signal) => {
  let registered = false
  let key: string | undefined
  const stop = (): LlmHostResult => ({ ok: false, registered, words: registered ? words.stoppedSaved : words.stopped })
  const question: LlmHostAsk = async plan => signal.aborted ? null : ask(plan)
  try {
    let existing: CompatEndpoint | undefined
    let action = 'add'
    const endpoints = configuredCompatEndpoints()
    if (endpoints.length) {
      const choice = await question({ step: 'servers', title: words.servers, found: words.choose, willRun: '', rows: [{ value: '__add__', label: words.add }, ...endpoints.map(endpoint => ({ value: endpoint.name, label: `${endpoint.label} · ${endpoint.baseUrl}` }))] })
      if (choice === null) return stop()
      existing = endpoints.find(endpoint => endpoint.name === choice)
      if (existing) {
        action = await question({ step: 'action', title: words.action, found: existing.baseUrl, willRun: '', rows: [{ value: 'recheck', label: words.recheck }, { value: 'repoint', label: words.repoint }, { value: 'remove', label: words.remove }] }) ?? 'stop'
        if (action === 'stop') return stop()
      }
    }
    if (existing && action === 'remove') {
      const answer = await question({ step: 'remove', title: words.remove, found: existing.name, willRun: 'Delete only this endpoint and its stored key. Environment keys and the server are untouched.', rows: [{ value: 'remove', label: words.remove }, { value: 'cancel', label: words.cancel }] })
      if (answer !== 'remove') return stop()
      editable()
      writeStoredCompatApiKey(null, existing.name)
      writeEndpoint(existing.name, undefined, existing)
      return { ok: true, words: words.removed }
    }
    const recheck = existing !== undefined && action === 'recheck'
    let baseUrl = existing?.baseUrl ?? ''
    if (!recheck) {
      for (;;) {
        const value = await question({ step: 'address', title: words.address, found: words.addressFound, willRun: words.addressRun, initial: baseUrl })
        if (value === null) return stop()
        try { baseUrl = compatServerBase(value); break } catch (error) { emit({ title: words.address, words: (error as Error).message }) }
      }
    }
    const changedAddress = existing !== undefined && existing.baseUrl !== baseUrl
    if (changedAddress && existing && (process.env[compatKeyEnvName(existing.name)] || existing.name === 'default' && (process.env.MERCURY_COMPAT_API_KEY || process.env.MERCURY_COMPAT_BASE_URL))) throw new Error('An environment pin controls this endpoint. Clear that pin before changing its address.')
    let probeEndpoint: CompatEndpointSettings & { baseUrl: string } = recheck && existing ? existing : { baseUrl }
    key = recheck && existing ? resolveCompatApiKey(process.env, existing.name)?.key : undefined
    let reading: CompatServerReading
    let suppliedKey = false
    for (;;) {
      try { reading = await inspectCompatServer(probeEndpoint, { key, signal, detect: true }); break }
      catch (error) {
        if (!(error instanceof CompatProbeError) || ![401, 403].includes(error.status ?? 0)) throw error
        const answer = await question({ step: 'key', title: words.key, found: words.keyRequired, willRun: words.keyRun, secret: true })
        if (answer === null) return stop()
        key = answer.trim() || undefined
        suppliedKey = true
      }
    }
    if (!reading.models.length) throw new Error(words.noModels)
    emit({ title: words.address, words: `${baseUrl} · ${reading.models.length} models` })
    const detected = reading.dialect ?? (recheck ? existing?.dialect : undefined)
    const picked = recheck ? existing?.dialect ?? 'chat-completions' : await question({ step: 'dialect', title: words.dialect, found: detected ? `Detected ${detected}. Confirm it, or choose another dialect.` : words.dialectUnknown, willRun: words.dialectRun, rows: [...LLM_HOST_DIALECTS].sort((a, b) => Number(b.value === detected) - Number(a.value === detected)) })
    if (picked === null) return stop()
    if (!LLM_HOST_DIALECTS.some(row => row.value === picked)) throw new Error(words.inputError)
    const dialect = picked as CompatDialect
    emit({ title: words.dialect, words: dialect })
    if (!suppliedKey && !recheck) {
      const answer = await question({ step: 'key', title: words.key, found: words.keyOptional, willRun: words.keyRun, secret: true })
      if (answer === null) return stop()
      key = answer.trim() || undefined
      suppliedKey = Boolean(key)
    }
    emit({ title: words.key, words: key ? 'key present · not written to settings' : 'no key' })
    probeEndpoint = { ...probeEndpoint, dialect }
    reading = await inspectCompatServer(probeEndpoint, { key, signal })
    const selected = await question({ step: 'model', title: words.model, found: `${reading.models.length} models listed by the server`, willRun: words.modelRun, rows: reading.models.map(model => ({ value: model, label: `${model} · ${hostWindowWords(reading.contextWindows[model])}` })) })
    if (selected === null) return stop()
    if (!reading.models.includes(selected)) throw new Error(words.inputError)
    emit({ title: words.model, words: `${selected} · ${hostWindowWords(reading.contextWindows[selected])}` })
    let name = existing?.name ?? 'llmhost'
    if (!existing) {
      for (;;) {
        const answer = await question({ step: 'name', title: words.name, found: words.nameFound, willRun: words.nameRun, initial: name })
        if (answer === null) return stop()
        name = answer.trim()
        if (COMPAT_ENDPOINT_NAME.test(name) && !configuredCompatEndpoints().some(endpoint => endpoint.name === name)) break
        emit({ title: words.name, words: 'Choose an unused name with 1–32 lowercase letters, digits or hyphens.' })
      }
    }
    const confirm = await question({ step: 'confirm', title: words.confirm, found: `${name} · ${baseUrl} · ${dialect} · ${selected}`, willRun: recheck ? words.recheckRun : words.confirmRun, rows: [{ value: 'run', label: recheck ? words.check : words.register }, { value: 'cancel', label: words.cancel }] })
    if (confirm !== 'run' || signal.aborted) return stop()
    const envKey = process.env[compatKeyEnvName(name)]?.trim() || (name === 'default' ? process.env.MERCURY_COMPAT_API_KEY?.trim() : undefined)
    if (envKey && envKey !== key) throw new Error(`${compatKeyEnvName(name)} takes precedence over a stored key. Clear that pin before registering a different key or address.`)
    if (!recheck) {
      editable()
      if (existing) writeStoredCompatApiKey(null, name)
      writeEndpoint(name, { baseUrl, label: name, dialect, ...(dialect === 'sglang' ? { sessionAffinityHeader: 'x-session-id' } : {}) }, existing)
    }
    registered = true
    if (suppliedKey && key) {
      const stored = await storeCompatApiKeyLogin(name, key)
      if (!stored.ok) throw new Error(stored.receipt)
    }
    const endpoint = configuredCompatEndpoints().find(entry => entry.name === name)
    if (!endpoint || endpoint.baseUrl !== baseUrl) throw new Error('The saved endpoint is overridden by another configuration source; no reply request was sent.')
    rememberCompatCatalogue(endpoint, reading)
    await refreshCompatCatalogues({ force: true, name, signal })
    if (signal.aborted) return stop()
    const fresh = cachedCompatCatalogue(endpoint)
    if (fresh?.error) throw new Error(fresh.error)
    const contextWindow = fresh?.contextWindows[selected] ?? reading.contextWindows[selected]
    if (contextWindow) registerHostWindow([`compat/${endpoint.named ? `${name}/` : ''}${selected}`], contextWindow)
    const model = `compat/${endpoint.named ? `${name}/` : ''}${selected}`
    const efforts = hostModelEfforts(selected, dialect, reading.efforts?.[selected])
    const savedFacts = updateSettingsForSource('userSettings', raw => ({ models: ModelFactsSchema().parse({ [model]: { ...(raw.models as Record<string, object> | undefined)?.[model], efforts: [...efforts] } }) }))
    if (savedFacts.error) throw savedFacts.error
    emit({ title: words.done, words: `${model} · available in /model and /logins` })
    const result = await checkLlmHostReply(model, signal)
    if (key) { result.words = result.words.split(key).join('[redacted]'); if (result.reply) result.reply = result.reply.split(key).join('[redacted]') }
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return signal.aborted ? stop() : { ok: false, registered, words: `${registered ? 'Provider saved · ' : ''}${key ? detail.split(key).join('[redacted]') : detail}` }
  }
}

export async function registerManagedLlmHost(name: string, baseUrl: string, dialect: CompatDialect, selected: string, previousBase: string | undefined, signal: AbortSignal): Promise<string> {
  const existing = configuredCompatEndpoints().find(endpoint => endpoint.name === name)
  if (existing && (!previousBase || existing.baseUrl !== previousBase)) throw new Error('Provider ' + name + ' is not the endpoint recorded for this computer; it was not replaced.')
  if (resolveCompatApiKey(process.env, name)) throw new Error('A key controls provider ' + name + '; choose a different computer name for this key-less service.')
  const reading = await inspectCompatServer({ baseUrl, dialect }, { signal })
  if (!reading.models.includes(selected)) throw new Error('The computer did not serve the selected model: ' + selected)
  if (!reading.contextWindows[selected]) throw new Error('The computer did not state the served model window.')
  signal.throwIfAborted()
  writeEndpoint(name, { baseUrl, label: 'box ' + name.slice(4), dialect, models: [selected] }, existing)
  const endpoint = configuredCompatEndpoints().find(row => row.name === name)
  if (!endpoint || endpoint.baseUrl !== baseUrl) throw new Error('The computer provider is overridden by another settings source.')
  rememberCompatCatalogue(endpoint, reading)
  return 'compat/' + name + '/' + selected
}

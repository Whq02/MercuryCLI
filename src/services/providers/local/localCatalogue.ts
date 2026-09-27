import type { ModelOption } from '../../../utils/model/modelOptions.js'
import {
  cachedLocalModels,
  getCachedLocalDiscovery,
  localModelRecord,
  refreshLocalDiscovery,
  type LocalContextSource,
  type LocalModelRecord,
} from './localDiscovery.js'

export const LOCAL_MODEL_PREFIX = 'local/'
export const LOCAL_MODEL_GROUP = 'Mercury — local models'

export function isLocalModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(LOCAL_MODEL_PREFIX)
}

export function localWireId(model: string): string {
  const trimmed = model.trim()
  const rest = trimmed.toLowerCase().startsWith(LOCAL_MODEL_PREFIX) ? trimmed.slice(LOCAL_MODEL_PREFIX.length) : trimmed
  const slash = rest.indexOf('/')
  if (slash > 0 && Object.hasOwn(LOCAL_SERVER_NAMES, rest.slice(0, slash).toLowerCase())) {
    return rest.slice(slash + 1)
  }
  return rest
}

export function localRecordFor(model: string): LocalModelRecord | undefined {
  if (!isLocalModelId(model)) return undefined
  return localModelRecord(model.trim().slice(LOCAL_MODEL_PREFIX.length))
}

export const LOCAL_SERVER_NAMES: Readonly<Record<LocalModelRecord['server'], string>> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  vllm: 'vLLM',
  llamacpp: 'llama.cpp',
  'openai-compatible': 'OpenAI-compatible server',
}

export function localContextSourceWords(source: LocalContextSource): string {
  switch (source) {
    case 'served':
      return 'served'
    case 'modelfile':
      return 'num_ctx'
    case 'model-max':
      return 'model max; the server sets the loaded size'
  }
}

export const LOCAL_WINDOW_SETTING_ROAD = '/config → Local model window, or /model → the model\'s row → context window'
export const LOCAL_WINDOW_REMEDY = `Raise the served window (${LOCAL_WINDOW_SETTING_ROAD}; at the server OLLAMA_CONTEXT_LENGTH or num_ctx)`

const fmtTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function localUnloadedWindowWords(record: LocalModelRecord): string {
  const chooser =
    record.server === 'ollama'
      ? 'Ollama serves OLLAMA_CONTEXT_LENGTH, else 4k/32k/256k by memory'
      : record.server === 'lmstudio'
        ? 'LM Studio sets the window at load'
        : 'the server sets the window at start'
  const trained = record.modelMaxContext !== undefined ? ` · trained maximum ${fmtTokens(record.modelMaxContext)}` : ''
  return `${record.loaded === false ? 'not loaded' : 'window not stated'}${trained} · ${chooser} · read at first send`
}

export function localWindowWords(record: LocalModelRecord): string {
  if (record.contextWindow === undefined) return localUnloadedWindowWords(record)
  return `${fmtTokens(record.contextWindow.tokens)} ctx · ${localContextSourceWords(record.contextWindow.source)}`
}

export function localPickerWindowNotice(model: string): string {
  const record = localRecordFor(model)
  if (!record) return 'context window unknown · no local server lists this model · not a toggle'
  return `${localWindowWords(record)} · not a toggle`
}

export interface LocalFitRefusalFacts {
  id: string
  estTokens: number
  toolCount: number
  window: number
  sourceWords: string
}

export function localFitRefusalSentence(facts: LocalFitRefusalFacts): string {
  return `the composed request (≈${Math.round(facts.estTokens / 1000)}k tokens, ${facts.toolCount} tool schemas included) cannot fit '${facts.id}'s served context window (${facts.window} tokens — ${facts.sourceWords}) and the server would silently truncate it. ${LOCAL_WINDOW_REMEDY}, restrict the tool catalog (--disallowed-tools / --strict-mcp-config), or pick a larger-window local model.`
}

const FIT_REFUSAL_RE = /the composed request \(≈(\d+)k tokens, (\d+) tool schemas included\) cannot fit '(.+?)'s served context window \((\d+) tokens — ([^)]+)\) and the server would silently truncate it/

export function localFitRefusalFacts(text: string): LocalFitRefusalFacts | null {
  const m = FIT_REFUSAL_RE.exec(text)
  if (!m) return null
  return { estTokens: Number(m[1]) * 1000, toolCount: Number(m[2]), id: m[3]!, window: Number(m[4]), sourceWords: m[5]! }
}

export function getLocalModelOptions(): ModelOption[] {
  void refreshLocalDiscovery().catch(() => {})
  const snapshot = getCachedLocalDiscovery()
  if (!snapshot) return []
  const rows: ModelOption[] = []
  const all = cachedLocalModels()
  const idCounts = new Map<string, number>()
  for (const record of all) {
    const key = record.id.toLowerCase()
    idCounts.set(key, (idCounts.get(key) ?? 0) + 1)
  }
  for (const record of all) {
    const collides = (idCounts.get(record.id.toLowerCase()) ?? 0) > 1
    const persisted = collides
      ? `${LOCAL_MODEL_PREFIX}${record.server}/${record.id}`
      : `${LOCAL_MODEL_PREFIX}${record.id}`
    rows.push({
      value: persisted,
      label: record.displayName ?? record.id,
      description: '',
      descriptionForModel: `${record.id} — served locally by ${LOCAL_SERVER_NAMES[record.server]} at ${record.baseUrl} (keyless, no metering); persisted as ${persisted}.${record.toolsDeclared === false ? ' The server declares no tool support — tool-bearing roles refuse it.' : ''}`,
      group: LOCAL_MODEL_GROUP,
      ...(record.contextWindow !== undefined ? { statedContextWindow: record.contextWindow.tokens } : {}),
    })
  }
  return rows
}

export function localDiscoverySummary(): { servers: number; models: number; labels: string[] } {
  const snapshot = getCachedLocalDiscovery()
  if (!snapshot) return { servers: 0, models: 0, labels: [] }
  return {
    servers: snapshot.servers.length,
    models: snapshot.servers.reduce((n, s) => n + s.models.length, 0),
    labels: snapshot.servers.map(s => s.label),
  }
}

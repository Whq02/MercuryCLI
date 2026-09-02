// ============================================================================
//  providers/local/localCatalogue — the /model rows and per-model facts for
//  locally served models, derived from the discovery snapshot.
// ----------------------------------------------------------------------------
//  The group renders ONLY what a server answered (law 1 — no phantom rows):
//  a quiet absence when nothing is found, the real model list with a
//  `local · <server>` detail line otherwise. Persisted ids are
//  `local/<model>`; the wire receives the server's own model name.
// ============================================================================
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
/** The picker group heading (the OPENAI_MODEL_GROUP grammar). */
export const LOCAL_MODEL_GROUP = 'Mercury — local models'

export function isLocalModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(LOCAL_MODEL_PREFIX)
}

/** The wire name for a persisted local id: the `local/` prefix detaches,
 *  and so does a `<server>/` segment (the collision-disambiguated form) —
 *  the server itself only knows its own bare listing name. */
export function localWireId(model: string): string {
  const trimmed = model.trim()
  const rest = trimmed.toLowerCase().startsWith(LOCAL_MODEL_PREFIX) ? trimmed.slice(LOCAL_MODEL_PREFIX.length) : trimmed
  const slash = rest.indexOf('/')
  if (slash > 0 && Object.hasOwn(LOCAL_SERVER_NAMES, rest.slice(0, slash).toLowerCase())) {
    return rest.slice(slash + 1)
  }
  return rest
}

/** The discovery record behind a persisted id (undefined = not discovered).
 *  The server segment of a disambiguated id stays ATTACHED here — the
 *  discovery owner resolves it to that server's record. */
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

/** Display words for a stated context window's provenance. */
export function localContextSourceWords(source: LocalContextSource): string {
  switch (source) {
    case 'served':
      return 'served'
    case 'modelfile':
      return 'num_ctx'
    case 'server-default':
      return 'server default — raise OLLAMA_CONTEXT_LENGTH or num_ctx'
    case 'model-max':
      return 'model max; the server sets the loaded size'
  }
}

/** The /model picker rows: absent (empty) until discovery finds a server —
 *  the group never paints a phantom; the open kicks a TTL'd refresh so the
 *  next open is current. Model rows carry NO description (the neutrality
 *  ruling: one empty grammar for every provider's model rows) — the window
 *  fact rides statedContextWindow, and the server/keyless facts ride the
 *  group heading detail (localDiscoverySummary). */
export function getLocalModelOptions(): ModelOption[] {
  void refreshLocalDiscovery().catch(() => {})
  const snapshot = getCachedLocalDiscovery()
  if (!snapshot) return []
  const rows: ModelOption[] = []
  const all = cachedLocalModels()
  // Two servers listing the SAME id would mint one identical persisted id
  // for two different models (first server silently wins) — a colliding id
  // persists server-qualified so each row names exactly one model.
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

/** Presence for the surfaces that summarize the family. */
export function localDiscoverySummary(): { servers: number; models: number; labels: string[] } {
  const snapshot = getCachedLocalDiscovery()
  if (!snapshot) return { servers: 0, models: 0, labels: [] }
  return {
    servers: snapshot.servers.length,
    models: snapshot.servers.reduce((n, s) => n + s.models.length, 0),
    labels: snapshot.servers.map(s => s.label),
  }
}

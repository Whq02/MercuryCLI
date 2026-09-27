import type { AssistantMessage, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildLocalExtras } from '../openaicompat/compatWire.js'
import { LOCAL_PULL_RECOMMENDATION, resolveLocalApiKey } from './localAccounts.js'
import { LOCAL_SERVER_NAMES, localContextSourceWords, localFitRefusalSentence, localRecordFor, localWireId } from './localCatalogue.js'
import { ensureServedWindow, getCachedLocalDiscovery, localModelRecord, refreshLocalDiscovery, type LocalModelRecord } from './localDiscovery.js'

export function localModelAcceptsEffort(record: LocalModelRecord): boolean {
  if (record.server === 'ollama' || record.server === 'lmstudio') return record.thinkingDeclared === true
  return record.server === 'vllm' || record.server === 'llamacpp'
}

export function localLaneProfileFor(record: LocalModelRecord): CompatLaneProfile {
  return {
    lane: 'local',
    providerLabel: LOCAL_SERVER_NAMES[record.server],
    resolveCredential: () => {
      const key = resolveLocalApiKey()
      return key ? { apiKey: key.key } : {}
    },
    credentialHint: 'the local server is not reachable.',
    authRemedy:
      'the server rejected the request credential — set MERCURY_LOCAL_API_KEY to the key the server was started with (its --api-key), or start it keyless.',
    requestUrl: () => `${record.baseUrl}/chat/completions`,
    wireModelId: () => record.id,
    buildExtras: args => buildLocalExtras({ ...args, server: record.server, acceptsEffort: localModelAcceptsEffort(record) }),
    omitsToolChoice: record.server === 'ollama',
    requestFitRefusal: ({ estTokens, toolCount }) => {
      const stated = record.contextWindow
      if (stated === undefined || (stated.source !== 'served' && stated.source !== 'modelfile')) return undefined
      const window = stated.tokens
      const OUTPUT_FLOOR = 1024
      if (estTokens + OUTPUT_FLOOR <= window) return undefined
      return localFitRefusalSentence({ id: record.id, estTokens, toolCount, window, sourceWords: localContextSourceWords(stated.source) })
    },
    toolCapabilityRefusal: () => {
      if (record.toolsDeclared === false) {
        return `${LOCAL_SERVER_NAMES[record.server]} lists '${record.id}' without tool support — this model cannot take a tool-bearing turn; pick a tool-capable local model (Ollama: capabilities include 'tools'; LM Studio: trained for tool use) for roles that carry tools.`
      }
      return undefined
    },
  }
}

export function undiscoveredLocalHint(modelId: string): string {
  const wire = localWireId(modelId)
  const ollama = getCachedLocalDiscovery()?.servers.find(server => server.kind === 'ollama')
  if (ollama) {
    return `no local server lists this model — ${ollama.label} answers but has not pulled '${wire}': ollama pull ${wire} (or ${LOCAL_PULL_RECOMMENDATION}); /model lists what is pulled and re-probes on open.`
  }
  return `no local server lists this model — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or point MERCURY_LOCAL_BASE_URL at your server, then ${LOCAL_PULL_RECOMMENDATION}; /model re-probes on open.`
}

function undiscoveredProfile(modelId: string): CompatLaneProfile {
  return {
    lane: 'local',
    providerLabel: 'Local models',
    resolveCredential: () => undefined,
    credentialHint: undiscoveredLocalHint(modelId),
    requestUrl: () => {
      throw new Error('undiscovered local model — resolveCredential refuses before this point')
    },
    wireModelId: id => localWireId(id),
    buildExtras: () => ({}),
  }
}

export function localLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('local')
}

export async function* localCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  let record = localRecordFor(params.options.model)
  if (!record) {
    await refreshLocalDiscovery({ force: true }).catch(() => undefined)
    record = localModelRecord(localWireId(params.options.model))
  }
  if (record) await ensureServedWindow(record, { signal: params.signal })
  yield* compatChatCallModel(record ? localLaneProfileFor(record) : undiscoveredProfile(params.options.model), params)
}

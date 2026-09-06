import type { AssistantMessage, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildLocalExtras } from '../openaicompat/compatWire.js'
import { resolveLocalApiKey } from './localAccounts.js'
import { LOCAL_SERVER_NAMES, localContextSourceWords, localRecordFor, localWireId } from './localCatalogue.js'
import { localModelRecord, refreshLocalDiscovery, type LocalModelRecord } from './localDiscovery.js'

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
      const window = record.contextWindow?.tokens
      if (window === undefined) return undefined
      const OUTPUT_FLOOR = 1024
      if (estTokens + OUTPUT_FLOOR <= window) return undefined
      const sourceWords = localContextSourceWords(record.contextWindow!.source)
      return `the composed request (≈${Math.round(estTokens / 1000)}k tokens, ${toolCount} tool schemas included) cannot fit '${record.id}'s served context window (${window} tokens — ${sourceWords}) and the server would silently truncate it. Raise the served window (OLLAMA_CONTEXT_LENGTH or num_ctx), restrict the tool catalog (--disallowed-tools / --strict-mcp-config), or pick a larger-window local model.`
    },
    toolCapabilityRefusal: () => {
      if (record.toolsDeclared === false) {
        return `${LOCAL_SERVER_NAMES[record.server]} lists '${record.id}' without tool support — this model cannot take a tool-bearing turn; pick a tool-capable local model (Ollama: capabilities include 'tools'; LM Studio: trained for tool use) for roles that carry tools.`
      }
      return undefined
    },
  }
}

const undiscoveredProfile: CompatLaneProfile = {
  lane: 'local',
  providerLabel: 'Local models',
  resolveCredential: () => undefined,
  credentialHint:
    'no local server lists this model — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or point MERCURY_LOCAL_BASE_URL at your server; /model re-probes on open.',
  requestUrl: () => {
    throw new Error('undiscovered local model — resolveCredential refuses before this point')
  },
  wireModelId: modelId => localWireId(modelId),
  buildExtras: () => ({}),
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
  yield* compatChatCallModel(record ? localLaneProfileFor(record) : undiscoveredProfile, params)
}

import type { AssistantMessage, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildLocalExtras, localThinkingOff } from '../openaicompat/compatWire.js'
import { LOCAL_PULL_RECOMMENDATION, resolveLocalApiKey } from './localAccounts.js'
import { LOCAL_SERVER_NAMES, localContextSourceWords, localFitRefusalSentence, localRecordFor, localWireId } from './localCatalogue.js'
import { confirmServedWindow, ensureServedWindow, getCachedLocalDiscovery, localModelRecord, refreshLocalDiscovery, residentServedWindow, type LocalDiscoveryIo, type LocalModelRecord } from './localDiscovery.js'
import { adoptableLocalWindow, adoptLocalWindow, decideLocalWindow, ensureLocalWindowTruth, heldLocalKnobs, heldLocalWindow, LOCAL_OUTPUT_FLOOR, localWindowApplication, localWindowSettingOf, releaseOutgrownLocalWindow, type HeldLocalWindow } from './localWindow.js'
import { noteLocalTurn } from './localWarm.js'
import { ollamaChatTransport, ollamaChatUrl } from './ollamaChatTransport.js'
import type { CompatCallModelParams as LocalCallParams } from '../openaicompat/compatChatCallModel.js'

export function localModelAcceptsEffort(record: LocalModelRecord): boolean {
  if (record.server === 'ollama' || record.server === 'lmstudio') return record.thinkingDeclared === true
  return record.server === 'vllm' || record.server === 'llamacpp'
}

export function localGuardWindow(record: LocalModelRecord, hold: HeldLocalWindow | undefined = heldLocalWindow(record)): { tokens: number; sourceWords: string } | undefined {
  const application = localWindowApplication(record)
  const applies = application === 'request' || application === 'load'
  if (applies && hold !== undefined && hold.window !== undefined) {
    return {
      tokens: hold.window,
      sourceWords: hold.setting === undefined ? 'chosen by Mercury for this session (auto) — /config → Local model window' : 'your setting — /config → Local model window',
    }
  }
  const stated = record.contextWindow
  if (stated === undefined || (stated.source !== 'served' && stated.source !== 'modelfile')) return undefined
  return { tokens: stated.tokens, sourceWords: localContextSourceWords(stated.source) }
}

export function localPreComposeEstimate(params: Pick<LocalCallParams, 'messages' | 'systemPrompt' | 'tools'>): number {
  let bytes = 0
  try {
    bytes += JSON.stringify(params.messages).length + JSON.stringify(params.systemPrompt).length
  } catch {
    bytes += 0
  }
  return Math.ceil(bytes / 4) + params.tools.length * 1000
}

export function localLaneProfileFor(record: LocalModelRecord): CompatLaneProfile {
  let thinkingEnabled = false
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
    buildExtras: args => {
      thinkingEnabled = args.thinkingEnabled
      return buildLocalExtras({ ...args, server: record.server, acceptsEffort: localModelAcceptsEffort(record) })
    },
    omitsToolChoice: record.server === 'ollama',
    ...(record.server === 'ollama'
      ? {
          streamTransport: (options: Parameters<NonNullable<CompatLaneProfile['streamTransport']>>[0]) =>
            ollamaChatTransport(
              { ...options, url: ollamaChatUrl(record.baseUrl) },
              {
                ...heldLocalKnobs(record),
                ...(record.thinkingDeclared === true ? { think: !localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled }) } : {}),
              },
            ),
        }
      : {}),
    requestFitRefusal: ({ estTokens, toolCount }) => {
      const guard = localGuardWindow(record)
      if (guard === undefined) return undefined
      if (estTokens + LOCAL_OUTPUT_FLOOR <= guard.tokens) return undefined
      return localFitRefusalSentence({ id: record.id, estTokens, toolCount, window: guard.tokens, sourceWords: guard.sourceWords })
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
  let confirmAfter = false
  if (record) {
    const application = localWindowApplication(record)
    const io: LocalDiscoveryIo = { signal: params.signal }
    if (application === 'request' || application === 'load') {
      const setting = localWindowSettingOf(record)
      const estTokens = localPreComposeEstimate(params)
      releaseOutgrownLocalWindow(record, estTokens)
      const decision = decideLocalWindow(record, estTokens, setting, await ensureLocalWindowTruth(record, setting))
      if (application === 'load') {
        await ensureServedWindow(record, io, decision.window !== undefined ? { numCtx: decision.window } : undefined)
      } else {
        confirmAfter = await settleOllamaWindow(record, decision, estTokens, io)
      }
    } else {
      await ensureServedWindow(record, io)
    }
  }
  noteLocalTurn(record)
  yield* compatChatCallModel(record ? localLaneProfileFor(record) : undiscoveredProfile(params.options.model), params)
  if (record && confirmAfter && !params.signal.aborted) await confirmServedWindow(record, { signal: params.signal })
}

export async function settleOllamaWindow(record: LocalModelRecord, decided: HeldLocalWindow, estTokens: number, io: LocalDiscoveryIo): Promise<boolean> {
  let hold = decided
  await ensureServedWindow(record, io, hold.window === undefined ? heldLocalKnobs(record) : { probeOnly: true })
  const resident = residentServedWindow(record)
  if (adoptableLocalWindow(hold, resident, estTokens)) hold = adoptLocalWindow(record, hold, resident)
  return hold.window === undefined || resident !== hold.window
}

// ============================================================================
//  providers/local/localCallModel — the locally-served lane profile over the
//  shared OpenAI-compatible runtime.
// ----------------------------------------------------------------------------
//  Wire facts (all fetched/read 2026-08-22; localDiscovery's header carries
//  the sources): every supported server speaks POST {base}/v1/chat/
//  completions with SSE streaming, function tools, and stream_options.
//  include_usage. Per kind:
//    · Ollama — the api key is required-but-ignored (keyless is the truth);
//      tool_choice is UNSUPPORTED, so the selector is omitted; a model whose
//      capabilities omit 'tools' cannot take a tool-bearing turn (typed
//      refusal); reasoning_effort low|medium|high|max for thinking models;
//    · LM Studio — keyless unless the server requires a token; a model whose
//      capabilities state trained_for_tool_use:false refuses tools;
//    · vLLM / llama.cpp — optional --api-key; tool support is a server
//      start-up fact the list does not state (the server answers honestly).
//  The base URL is the DISCOVERED server's (each model knows its server);
//  an undiscovered local/<id> refuses with the probe route rather than
//  guessing a port. VERIFIED against a live endpoint: discovery, streamed text turns, streamed
//  reasoning, and multi-round tool loops all settled against a real Ollama;
//  the subagent-dispatch, search-door and SATURN-fire legs remain
//  operator-deferred drill lines.
// ============================================================================
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

/** True when the server's stated vocabulary applies to this model: Ollama
 *  and LM Studio state a thinking capability per model; vLLM and llama.cpp
 *  hand the knob to the chat template for any model. */
export function localModelAcceptsEffort(record: LocalModelRecord): boolean {
  if (record.server === 'ollama' || record.server === 'lmstudio') return record.thinkingDeclared === true
  return record.server === 'vllm' || record.server === 'llamacpp'
}

/** One profile per dispatch: the runtime reads the profile's fields per
 *  call, and the server/knobs belong to the DISCOVERED record, so the
 *  profile is minted around that record. */
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
    // The server's OWN listing name — immune to any persisted spelling
    // (including the server-qualified collision form).
    wireModelId: () => record.id,
    buildExtras: args => buildLocalExtras({ ...args, server: record.server, acceptsEffort: localModelAcceptsEffort(record) }),
    omitsToolChoice: record.server === 'ollama',
    // THE SILENT-TRUNCATION GUARD (proven live): a
    // request larger than the SERVED window is not sent — Ollama and kin
    // truncate silently on /v1 (no per-request window raise exists there),
    // and a truncated prompt answers garbage with no signal. Refuse typed
    // with the numbers and the remedy ladder instead. Only a STATED window
    // checks; an unstated one is the server's own business.
    requestFitRefusal: ({ estTokens, toolCount }) => {
      const window = record.contextWindow?.tokens
      if (window === undefined) return undefined
      const OUTPUT_FLOOR = 1024
      if (estTokens + OUTPUT_FLOOR <= window) return undefined
      const sourceWords = localContextSourceWords(record.contextWindow!.source)
      return `the composed request (≈${Math.round(estTokens / 1000)}k tokens, ${toolCount} tool schemas included) cannot fit '${record.id}'s served context window (${window} tokens — ${sourceWords}) and the server would silently truncate it. Raise the served window (OLLAMA_CONTEXT_LENGTH or num_ctx), restrict the tool catalog (--disallowedTools / --strict-mcp-config), or pick a larger-window local model.`
    },
    toolCapabilityRefusal: () => {
      if (record.toolsDeclared === false) {
        return `${LOCAL_SERVER_NAMES[record.server]} lists '${record.id}' without tool support — this model cannot take a tool-bearing turn; pick a tool-capable local model (Ollama: capabilities include 'tools'; LM Studio: trained for tool use) for roles that carry tools.`
      }
      return undefined
    },
  }
}

/** The profile used when a local id was never discovered — refuses with
 *  the probe route (never a guessed port, never another provider). */
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

/** The provider-aware callModel branch for local models: re-probes (TTL'd)
 *  so a server started after boot is found, then dispatches against the
 *  model's own server. */
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

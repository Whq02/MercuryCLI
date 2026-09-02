// ============================================================================
//  providers/callModelRouter — the provider-aware QueryDeps.callModel seam
// ONE routing law over the
//  resolved model id (owned by ./routeLaw.ts, pure — light modules read it
//  without this file's runtime graph):
//
//    - glm-* ids run on the Z.AI native in-process runtime (zaiCallModel);
//    - gpt-* ids run on the native OpenAI Responses runtime (openaiCallModel);
//    - kimi-*/moonshot-* ids run on the Moonshot/Kimi chat-completions lane;
//    - deepseek-* ids run on the DeepSeek chat-completions lane;
//    - compat/… ids run on the operator-named OpenAI-compatible slot;
//    - everything else is the existing Anthropic path, byte-identical.
//
//  Each native runtime owns its honest account-absent refusals, so a routed
//  id can never silently fall through to another provider (NO cross-provider
//  fallback).
// ============================================================================
import { queryModelWithStreaming } from '../providers/anthropic/index.js'
import { API_ERROR_MESSAGE_PREFIX } from '../api/errors.js'
import { APIUserAbortError } from '../api/sdkErrors.js'
import type { AssistantMessage } from '../../types/message.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { openaiCallModel } from './openai/openaiCallModel.js'
import { zaiCallModel } from './zai/zaiCallModel.js'
import { moonshotCallModel } from './moonshot/moonshotCallModel.js'
import { deepseekCallModel } from './deepseek/deepseekCallModel.js'
import { compatCallModel } from './openaicompat/compatCallModel.js'
import { classifyModelRoute } from './routeLaw.js'
import { openrouterCallModel } from './openrouter/openrouterCallModel.js'
import { geminiCallModel } from './gemini/geminiCallModel.js'
import { huggingfaceCallModel } from './huggingface/huggingfaceCallModel.js'
import { localCallModel } from './local/localCallModel.js'
import { homeLaneAdmissionRefusal } from './homeLaneAdmission.js'

export {
  classifyModelRoute,
  declaredRouteOf,
  laneLabelForVerdict,
  qualifiedWireId,
  COMPAT_MODEL_PREFIX,
  isCompatModelId,
  stripCompatModelPrefix,
  PROVIDER_ID_SPACES,
  type CallModelRoute,
  type ModelRouteVerdict,
  type ProviderIdSpace,
} from './routeLaw.js'

/**
 * The MULTI-AUTH-NATIVE settlement fold, as a pure function (exported for
 * its prover): the Anthropic lane settles one assistant message carrying
 * the whole turn, but every routed family (openai · zai · the compat lanes)
 * mints ONE message PER content block — reasoning first, text after.
 * Keeping only the last yield returned a single block (or the empty settle
 * of a reasoning-only turn) and consumers saw "non-JSON output" on families
 * that had answered correctly. The fold: keep every settled assistant
 * message, prefer content over API-error yields (errors surface only when
 * they are the only settlement), and answer the LAST message (it carries
 * the final usage / stop_reason by direct mutation) widened to the WHOLE
 * turn's blocks in yield order.
 */
export function settleAssistantTurn(
  settled: readonly AssistantMessage[],
  aborted: boolean,
): AssistantMessage {
  const content = settled.filter(m => !m.isApiErrorMessage)
  const pool = content.length > 0 ? content : settled
  const last = pool.at(-1)
  if (!last) {
    if (aborted) throw new APIUserAbortError()
    throw new Error('No assistant message found')
  }
  if (pool.length === 1) return last
  return {
    ...last,
    message: {
      ...last.message,
      content: pool.flatMap(m => m.message.content),
    },
  }
}

/**
 * Drain routedCallModel to ONE settled assistant message — the routed
 * sibling of queryModelWithoutStreaming, for utility one-shots that must
 * ride the session's own provider family (away recap, agent-state
 * classification, feedback titles). Same params, same settlement fold as
 * queryWithModel; an abort surfaces as APIUserAbortError.
 */
export async function routedCallModelSettled(
  params: Parameters<typeof queryModelWithStreaming>[0],
): Promise<AssistantMessage> {
  const settled: AssistantMessage[] = []
  for await (const message of routedCallModel(params)) {
    if (message.type === 'assistant') settled.push(message as AssistantMessage)
  }
  return settleAssistantTurn(settled, params.signal.aborted)
}

/** The home arm both earned kinds share: the admission owner decides (the
 *  wire-id law; for a stranger, the earned-fact law), then the home
 *  transport carries the turn. */
async function* homeLaneCall(
  params: Parameters<typeof queryModelWithStreaming>[0],
): ReturnType<typeof queryModelWithStreaming> {
  const refusal = homeLaneAdmissionRefusal(params.options.model)
  if (refusal !== null) {
    yield createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`,
      error: 'invalid_request',
    })
    return
  }
  yield* queryModelWithStreaming(params)
}

/** Drop-in for queryModelWithStreaming — productionDeps().callModel. */
export const routedCallModel: typeof queryModelWithStreaming = async function* (params) {
  const verdict = classifyModelRoute(params.options.model)
  if (verdict.kind === 'absence') {
    // No id at all is never classified onto a lane (the operator's phase-2
    // ruling): the session model resolves upstream (/model's pick or the
    // built-in default) — a dispatch handed none refuses honestly.
    yield createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: no model id rides this call — the session's model resolves upstream (/model names one; the built-in default otherwise), and this dispatch was handed none.`,
      error: 'invalid_request',
    })
    return
  }
  if (verdict.kind === 'unrecognised') {
    // The stranger's only road is the EARNED home ride: the admission owner
    // decides (a gateway base URL admits — the endpoint owns its ids;
    // otherwise the typed refusal, before any HTTP) and the ride is the
    // home TRANSPORT — a gateway ride, never a first-party identity.
    yield* homeLaneCall(params)
    return
  }
  switch (verdict.route) {
    case 'zai':
      yield* zaiCallModel(params)
      return
    case 'openai':
      yield* openaiCallModel(params)
      return
    case 'moonshot':
      yield* moonshotCallModel(params)
      return
    case 'deepseek':
      yield* deepseekCallModel(params)
      return
    case 'openai-compat':
      yield* compatCallModel(params)
      return
    case 'openrouter':
      // FOLD LANDED: the auth lane's runtime rides the shared
      // compat chat runtime — recognition and dispatch are one law now.
      yield* openrouterCallModel(params)
      return
    case 'gemini':
      yield* geminiCallModel(params)
      return
    case 'huggingface':
      yield* huggingfaceCallModel(params)
      return
    case 'local':
      yield* localCallModel(params)
      return
    case 'anthropic':
      // The EARNED first-party lane (claude-mark · alias · env-pin — the
      // verdict's why): the same admission owner speaks first (the wire-id
      // law is not suspended at home), then the Anthropic path
      // byte-identical.
      yield* homeLaneCall(params)
      return
  }
}

import { getSessionId } from '../../../bootstrap/state.js'
import type { OpenaiFault, OpenaiResponsesRequest } from './openaiWire.js'

const EXTENDED_RETENTION = new Set(['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-chat-latest', 'gpt-5', 'gpt-5-codex', 'gpt-4.1'])
const rejected = new Set<string>()
const keyOf = (model: string): string => JSON.stringify([getSessionId(), model])

export function openaiCacheRetention(model: string, source: string): Pick<OpenaiResponsesRequest, 'prompt_cache_retention'> {
  return source === 'api-key' && EXTENDED_RETENTION.has(model) && !rejected.has(keyOf(model)) ? { prompt_cache_retention: '24h' } : {}
}

export function rejectOpenaiCacheRetention(model: string, fault: Pick<OpenaiFault, 'kind' | 'status' | 'message' | 'inStream'>): boolean {
  if ((fault.kind !== 'http-error' && fault.kind !== 'api-error') || fault.inStream === true || fault.status !== 400 || !fault.message.includes('prompt_cache_retention')) return false
  rejected.add(keyOf(model))
  return true
}

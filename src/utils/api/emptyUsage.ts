import { unbuilt } from '../../pi/holes.js'

export type NonNullableUsage = {
  usage_source?: 'estimated'
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use: {
    web_fetch_requests: number
    web_search_requests: number
  }
  service_tier: 'standard' | 'priority' | 'batch' | null
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string | null
  iterations: unknown[] | null
  speed: 'standard' | 'fast' | null
  output_tokens_details: { thinking_tokens: number } | null
}

export const EMPTY_USAGE: Readonly<NonNullableUsage> = unbuilt('src/utils/api/emptyUsage.ts:22')
export function usageCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

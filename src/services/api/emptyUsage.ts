export type NonNullableUsage = {
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

export const EMPTY_USAGE: Readonly<NonNullableUsage> = Object.freeze({
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: {
    web_search_requests: 0,
    web_fetch_requests: 0,
  },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: null,
  speed: 'standard',
  output_tokens_details: null,
})

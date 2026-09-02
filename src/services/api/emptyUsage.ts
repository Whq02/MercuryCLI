import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'

/**
 * The zero-valued usage record, split into its own module so light consumers
 * (the REPL bridge) can import it without pulling the error module and,
 * transitively, the whole tool graph.
 */
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

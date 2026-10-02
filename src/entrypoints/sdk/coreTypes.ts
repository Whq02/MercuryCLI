export type {
  SandboxSettings,
  SandboxNetworkConfig,
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
} from '../sandboxTypes.js'
export * from './coreTypesInferred.js'

export const MERCURY_SDK_CONTRACT_VERSION = 3

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

import type { ApiToolUnion, JsonOutputFormat, MessageParam, TextBlockParam } from '../../../types/wire.js'

export type AnthropicOutputConfig = {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  format?: JsonOutputFormat | null
}

export type AnthropicMessageParams = {
  model: string
  messages: MessageParam[]
  max_tokens: number
  system?: string | TextBlockParam[]
  tools?: ApiToolUnion[]
  tool_choice?: { type: 'auto'; disable_parallel_tool_use?: boolean } | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean } | { type: 'any'; disable_parallel_tool_use?: boolean } | { type: 'none' }
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' } | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' } | { type: 'disabled' }
  output_config?: AnthropicOutputConfig
  metadata?: { user_id?: string | null }
  betas?: string[]
  user_profile_id?: string | null
  stream?: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  [key: string]: unknown
}

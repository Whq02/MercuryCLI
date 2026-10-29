type TextCitation = { type: string }

type CitationLocation = { type: string }

type ToolCaller = { type: string; tool_id?: string }

export type TextPhase = 'commentary' | 'final_answer'

type TextBlock = {
  type: 'text'
  text: string
  citations: Array<TextCitation> | null
  phase?: TextPhase
}

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature: string
}

export type RedactedThinkingBlock = {
  type: 'redacted_thinking'
  data: string
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  caller?: ToolCaller
}

type ServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: string
  input: { [key: string]: unknown }
  caller?: ToolCaller
}

type WebSearchResultItem = {
  type: string
  title: string
  url: string
  page_age?: string | null
}

type WebSearchToolResultBlock = {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: Array<WebSearchResultItem> | { type: string; error_code: string }
  caller?: ToolCaller
}

type WebFetchToolResultBlock = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: unknown
  caller?: ToolCaller
}

type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content: unknown
}

type CodeExecutionToolResultBlock = {
  type: 'code_execution_tool_result'
  tool_use_id: string
  content: unknown
}

type BashCodeExecutionToolResultBlock = {
  type: 'bash_code_execution_tool_result'
  tool_use_id: string
  content: unknown
}

type TextEditorCodeExecutionToolResultBlock = {
  type: 'text_editor_code_execution_tool_result'
  tool_use_id: string
  content: unknown
}

type ToolSearchToolResultBlock = {
  type: 'tool_search_tool_result'
  tool_use_id: string
  content: unknown
}

type McpToolUseBlock = {
  type: 'mcp_tool_use'
  id: string
  name: string
  input: unknown
  server_name: string
}

type McpToolResultBlock = {
  type: 'mcp_tool_result'
  tool_use_id: string
  is_error: boolean
  content: string | Array<TextBlock>
}

type ContainerUploadBlock = {
  type: 'container_upload'
  file_id: string
}

type CompactionBlock = {
  type: 'compaction'
  content: string | null
  encrypted_content: string | null
}

type FallbackBlock = {
  type: 'fallback'
  from: { model: string }
  to: { model: string }
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock
  | AdvisorToolResultBlock
  | CodeExecutionToolResultBlock
  | BashCodeExecutionToolResultBlock
  | TextEditorCodeExecutionToolResultBlock
  | ToolSearchToolResultBlock
  | McpToolUseBlock
  | McpToolResultBlock
  | ContainerUploadBlock
  | CompactionBlock
  | FallbackBlock

type CacheCreation = {
  ephemeral_1h_input_tokens: number
  ephemeral_5m_input_tokens: number
}

type ServerToolUsage = {
  web_fetch_requests: number
  web_search_requests: number
}

type OutputTokensDetails = { thinking_tokens: number }

export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation: CacheCreation | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  inference_geo: string | null

  iterations: unknown[] | null
  output_tokens_details: OutputTokensDetails | null
  server_tool_use: ServerToolUsage | null
  service_tier: 'standard' | 'priority' | 'batch' | null
  speed: 'standard' | 'fast' | null
}

type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'compaction'
  | 'refusal'
  | 'model_context_window_exceeded'

type RefusalStopDetails = {
  type: 'refusal'
  category: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null
  explanation: string | null
  fallback_credit_token: string | null
  fallback_has_prefill_claim: boolean | null
  recommended_model: string | null
}

export type ApiMessage = {
  type: 'message'
  role: 'assistant'
  id: string
  model: string
  content: Array<ContentBlock>
  stop_reason: StopReason | null
  stop_sequence: string | null
  usage: ApiUsage

  container: unknown | null

  context_management: unknown | null
  diagnostics?: unknown | null
  stop_details?: RefusalStopDetails | null

  input_transformations?: InputTransformation[] | null
}

export type InputTransformation = {
  type: string
  path: string
  reason: string
}

type ApiTextDelta = { type: 'text_delta'; text: string }
type ApiInputJsonDelta = { type: 'input_json_delta'; partial_json: string }
type ApiCitationsDelta = { type: 'citations_delta'; citation: CitationLocation }
type ApiThinkingDelta = {
  type: 'thinking_delta'
  thinking: string
  estimated_tokens?: number | null
}
type ApiSignatureDelta = { type: 'signature_delta'; signature: string }
type ApiCompactionDelta = {
  type: 'compaction_delta'
  content: string | null
  encrypted_content: string | null
}

export type ApiContentBlockDelta =
  | ApiTextDelta
  | ApiInputJsonDelta
  | ApiCitationsDelta
  | ApiThinkingDelta
  | ApiSignatureDelta
  | ApiCompactionDelta

export type ApiMessageDeltaUsage = {
  output_tokens: number
  input_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  iterations: unknown[] | null
  output_tokens_details: OutputTokensDetails | null
  server_tool_use: ServerToolUsage | null
}

type ApiMessageStartEvent = {
  type: 'message_start'
  message: ApiMessage
}

type ApiMessageDeltaEvent = {
  type: 'message_delta'
  delta: {
    stop_reason: StopReason | null
    stop_sequence: string | null
  }
  usage: ApiMessageDeltaUsage
  context_management?: unknown | null
}

type ApiMessageStopEvent = { type: 'message_stop' }

type ApiContentBlockStartEvent = {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}

type ApiContentBlockDeltaEvent = {
  type: 'content_block_delta'
  index: number
  delta: ApiContentBlockDelta
}

type ApiContentBlockStopEvent = {
  type: 'content_block_stop'
  index: number
}

export type ApiStreamEvent =
  | ApiMessageStartEvent
  | ApiMessageDeltaEvent
  | ApiMessageStopEvent
  | ApiContentBlockStartEvent
  | ApiContentBlockDeltaEvent
  | ApiContentBlockStopEvent

type CacheControlEphemeral = {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

type CitationsConfigParam = { enabled?: boolean }

export type Base64ImageSource = {
  type: 'base64'
  data: string
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

type URLImageSource = { type: 'url'; url: string }

type Base64PDFSource = {
  type: 'base64'
  data: string
  media_type: 'application/pdf'
}

type PlainTextSource = {
  type: 'text'
  data: string
  media_type: 'text/plain'
}

type URLPDFSource = { type: 'url'; url: string }

type ContentBlockSource = {
  type: 'content'
  content: string | Array<TextBlockParam | ImageBlockParam>
}

export type TextBlockParam = {
  type: 'text'
  text: string
  cache_control?: CacheControlEphemeral | null
  citations?: Array<TextCitation> | null
  phase?: TextPhase
}

export type ImageBlockParam = {
  type: 'image'
  source: Base64ImageSource | URLImageSource
  cache_control?: CacheControlEphemeral | null
}

export type DocumentBlockParam = {
  type: 'document'
  source: Base64PDFSource | PlainTextSource | ContentBlockSource | URLPDFSource
  cache_control?: CacheControlEphemeral | null
  citations?: CitationsConfigParam | null
  context?: string | null
  title?: string | null
}

type SearchResultBlockParam = {
  type: 'search_result'
  content: Array<TextBlockParam>
  source: string
  title: string
  cache_control?: CacheControlEphemeral | null
  citations?: CitationsConfigParam
}

export type ThinkingBlockParam = {
  type: 'thinking'
  thinking: string
  signature: string
}

export type RedactedThinkingBlockParam = {
  type: 'redacted_thinking'
  data: string
}

export type ToolUseBlockParam = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

type ToolReferenceBlockParam = {
  type: 'tool_reference'
  tool_name: string
  cache_control?: CacheControlEphemeral | null
}

export type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  cache_control?: CacheControlEphemeral | null
  content?:
    | string
    | Array<
        | TextBlockParam
        | ImageBlockParam
        | SearchResultBlockParam
        | DocumentBlockParam
        | ToolReferenceBlockParam
      >
  is_error?: boolean
}

type ServerToolUseBlockParam = {
  type: 'server_tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

type WebSearchToolResultBlockParam = {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

type WebFetchToolResultBlockParam = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

type CodeExecutionToolResultBlockParam = {
  type: 'code_execution_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

type BashCodeExecutionToolResultBlockParam = {
  type: 'bash_code_execution_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

type TextEditorCodeExecutionToolResultBlockParam = {
  type: 'text_editor_code_execution_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

type ToolSearchToolResultBlockParam = {
  type: 'tool_search_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

type ContainerUploadBlockParam = {
  type: 'container_upload'
  file_id: string
  cache_control?: CacheControlEphemeral | null
}

type MidConversationSystemBlockParam = {
  type: 'mid_conv_system'
  content: Array<TextBlockParam>
  cache_control?: CacheControlEphemeral | null
}

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | DocumentBlockParam
  | SearchResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | ToolUseBlockParam
  | ToolReferenceBlockParam
  | ToolResultBlockParam
  | ServerToolUseBlockParam
  | WebSearchToolResultBlockParam
  | WebFetchToolResultBlockParam
  | CodeExecutionToolResultBlockParam
  | BashCodeExecutionToolResultBlockParam
  | TextEditorCodeExecutionToolResultBlockParam
  | ToolSearchToolResultBlockParam
  | ContainerUploadBlockParam
  | MidConversationSystemBlockParam
  | ContentBlock

export type MessageParam = {
  role: 'user' | 'assistant'
  content: string | Array<ContentBlockParam>
}

export type JsonOutputFormat = {
  type: 'json_schema'
  schema: { [key: string]: unknown }
}

export type ToolInputSchema = {
  type: 'object'
  properties?: unknown | null
  required?: Array<string> | null
  [key: string]: unknown
}

export type ApiTool = {
  name: string
  input_schema: ToolInputSchema
  description?: string
  allowed_callers?: Array<string>
  cache_control?: CacheControlEphemeral | null
  defer_loading?: boolean
  eager_input_streaming?: boolean | null
  input_examples?: Array<{ [key: string]: unknown }>
  strict?: boolean
  type?: 'custom' | null
}

type ServerToolDescriptor = {
  name: string
  type: string
  allowed_callers?: Array<string>
  allowed_domains?: Array<string> | null
  blocked_domains?: Array<string> | null
  cache_control?: CacheControlEphemeral | null
  defer_loading?: boolean
  max_uses?: number | null
  strict?: boolean
  user_location?: unknown | null
}

export type ApiToolUnion = ApiTool | ServerToolDescriptor

export type ApiRequestParams = {
  model?: string
  messages?: unknown[]
  system?: unknown
  tools?: unknown[]
  max_tokens?: number
  stream?: boolean
  betas?: string[]
  thinking?: unknown
  output_config?: unknown
  metadata?: unknown
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
}

export type StreamCapabilityAdvertisement = {

  textDelta: boolean

  reasoningDelta: boolean

  toolArgsDelta: boolean

  usage: boolean

  timing: boolean
}

// ============================================================================
//  types/wire — the Mercury wire vocabulary.
//
//  Mercury-OWNED structural types for the API-shaped values the application
//  carries: response content blocks, request param blocks, the assistant
//  message envelope, usage, and the stream-part grammar. This module is the
//  ONE in-app spelling of these shapes — types/message.ts builds the message
//  taxonomy over it, renderers/tools/loop consume it, and NO file outside the
//  provider codec leaves imports '@anthropic-ai/sdk' types for them.
//
//  Laws:
//    · STRUCTURAL CLONES, bounded at read depth: every field the application
//      reads is typed precisely; sub-shapes nothing outside the provider
//      leaves reads (citation variants, server-tool result contents,
//      diagnostics internals) are bounded to `unknown` / open `{type:string}`
//      — real provider values remain assignable WITHOUT casts, and deepening
//      a bound later is a compatible change.
//    · The provider SDK leaf (services/providers/anthropic/**) is where these shapes
//      meet '@anthropic-ai/sdk' — the leaf casts at ITS boundary; an SDK
//      upgrade lands there (IDM), never here.
//    · The transcript stores these shapes verbatim; the fabric record model
//      (src/fabric/record.ts) is the DURABLE vocabulary and bridges
//      losslessly — this module is the LIVE in-app dialect.
// ============================================================================

// ── shared open bounds ──────────────────────────────────────────────────────

/** A citation attached to a text block. Carried verbatim; no consumer outside
 *  the provider leaves reads past the discriminant. */
export type TextCitation = { type: string }

/** A citation delta's payload (carried verbatim, unread in-app). */
export type CitationLocation = { type: string }

/** tool_use caller attribution (direct | server-tool variants). */
export type ToolCaller = { type: string; tool_id?: string }

// ── response content blocks ─────────────────────────────────────────────────

export type TextBlock = {
  type: 'text'
  text: string
  citations: Array<TextCitation> | null
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

export type ServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: string
  input: { [key: string]: unknown }
  caller?: ToolCaller
}

/** One web-search hit (bounded to the fields the search tool reads). */
export type WebSearchResultItem = {
  type: string
  title: string
  url: string
  page_age?: string | null
}

export type WebSearchToolResultBlock = {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: Array<WebSearchResultItem> | { type: string; error_code: string }
  caller?: ToolCaller
}

export type WebFetchToolResultBlock = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: unknown
  caller?: ToolCaller
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content: unknown
}

export type CodeExecutionToolResultBlock = {
  type: 'code_execution_tool_result'
  tool_use_id: string
  content: unknown
}

export type BashCodeExecutionToolResultBlock = {
  type: 'bash_code_execution_tool_result'
  tool_use_id: string
  content: unknown
}

export type TextEditorCodeExecutionToolResultBlock = {
  type: 'text_editor_code_execution_tool_result'
  tool_use_id: string
  content: unknown
}

export type ToolSearchToolResultBlock = {
  type: 'tool_search_tool_result'
  tool_use_id: string
  content: unknown
}

export type McpToolUseBlock = {
  type: 'mcp_tool_use'
  id: string
  name: string
  input: unknown
  server_name: string
}

export type McpToolResultBlock = {
  type: 'mcp_tool_result'
  tool_use_id: string
  is_error: boolean
  content: string | Array<TextBlock>
}

export type ContainerUploadBlock = {
  type: 'container_upload'
  file_id: string
}

export type CompactionBlock = {
  type: 'compaction'
  content: string | null
  encrypted_content: string | null
}

export type FallbackBlock = {
  type: 'fallback'
  from: { model: string }
  to: { model: string }
}

/** The settled-content union an assistant turn carries (transcript truth). */
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

// ── usage + message envelope ────────────────────────────────────────────────

export type CacheCreation = {
  ephemeral_1h_input_tokens: number
  ephemeral_5m_input_tokens: number
}

export type ServerToolUsage = {
  web_fetch_requests: number
  web_search_requests: number
}

export type OutputTokensDetails = { thinking_tokens: number }

export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation: CacheCreation | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  inference_geo: string | null
  /** Per-iteration usage rows (advisor/compaction laps). Read via narrowing
   *  casts at the two accounting sites; carried verbatim. */
  iterations: unknown[] | null
  output_tokens_details: OutputTokensDetails | null
  server_tool_use: ServerToolUsage | null
  service_tier: 'standard' | 'priority' | 'batch' | null
  speed: 'standard' | 'fast' | null
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'compaction'
  | 'refusal'
  | 'model_context_window_exceeded'

export type RefusalStopDetails = {
  type: 'refusal'
  category: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null
  explanation: string | null
  fallback_credit_token: string | null
  fallback_has_prefill_claim: boolean | null
  recommended_model: string | null
}

/**
 * The raw API message carried on an AssistantMessage. `diagnostics` and
 * `stop_details` are optional: synthetic producers build the literal without
 * them (types/message.ts law, unchanged).
 */
export type ApiMessage = {
  type: 'message'
  role: 'assistant'
  id: string
  model: string
  content: Array<ContentBlock>
  stop_reason: StopReason | null
  stop_sequence: string | null
  usage: ApiUsage
  /** Sandbox container descriptor — carried verbatim, unread in-app. */
  container: unknown | null
  /** Applied context-management edits — carried verbatim, unread in-app. */
  context_management: unknown | null
  diagnostics?: unknown | null
  stop_details?: RefusalStopDetails | null
  /** Preserved-thinking controls (beta thinking-binding-controls-2026-08-01):
   *  one entry per thinking block the API dropped before the model read the
   *  request — empty when nothing was dropped, absent without the header. */
  input_transformations?: InputTransformation[] | null
}

/** One dropped input block under the preserved-thinking controls. `reason`
 *  is `prefix_binding_mismatch` (the history before `path` changed since
 *  the block was minted) or `model_binding_mismatch` (the conversation
 *  switched models); later checks add values — read, never switch on. */
export type InputTransformation = {
  type: string
  path: string
  reason: string
}

// ── the stream-part grammar ─────────────────────────────────────────────────

export type ApiTextDelta = { type: 'text_delta'; text: string }
export type ApiInputJsonDelta = { type: 'input_json_delta'; partial_json: string }
export type ApiCitationsDelta = { type: 'citations_delta'; citation: CitationLocation }
export type ApiThinkingDelta = {
  type: 'thinking_delta'
  thinking: string
  estimated_tokens?: number | null
}
export type ApiSignatureDelta = { type: 'signature_delta'; signature: string }
export type ApiCompactionDelta = {
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

export type ApiMessageStartEvent = {
  type: 'message_start'
  message: ApiMessage
}

export type ApiMessageDeltaEvent = {
  type: 'message_delta'
  delta: {
    stop_reason: StopReason | null
    stop_sequence: string | null
  }
  usage: ApiMessageDeltaUsage
  context_management?: unknown | null
}

export type ApiMessageStopEvent = { type: 'message_stop' }

export type ApiContentBlockStartEvent = {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}

export type ApiContentBlockDeltaEvent = {
  type: 'content_block_delta'
  index: number
  delta: ApiContentBlockDelta
}

export type ApiContentBlockStopEvent = {
  type: 'content_block_stop'
  index: number
}

/** The model-stream part grammar the loop, fan-out, and renderers consume —
 *  Mercury's native event language; every provider codec produces it. */
export type ApiStreamEvent =
  | ApiMessageStartEvent
  | ApiMessageDeltaEvent
  | ApiMessageStopEvent
  | ApiContentBlockStartEvent
  | ApiContentBlockDeltaEvent
  | ApiContentBlockStopEvent

// ── request param blocks ────────────────────────────────────────────────────

export type CacheControlEphemeral = {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

export type CitationsConfigParam = { enabled?: boolean }

export type Base64ImageSource = {
  type: 'base64'
  data: string
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

export type URLImageSource = { type: 'url'; url: string }

export type Base64PDFSource = {
  type: 'base64'
  data: string
  media_type: 'application/pdf'
}

export type PlainTextSource = {
  type: 'text'
  data: string
  media_type: 'text/plain'
}

export type URLPDFSource = { type: 'url'; url: string }

export type ContentBlockSource = {
  type: 'content'
  content: string | Array<TextBlockParam | ImageBlockParam>
}

export type TextBlockParam = {
  type: 'text'
  text: string
  cache_control?: CacheControlEphemeral | null
  citations?: Array<TextCitation> | null
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

export type SearchResultBlockParam = {
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

export type ToolReferenceBlockParam = {
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

export type ServerToolUseBlockParam = {
  type: 'server_tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

export type WebSearchToolResultBlockParam = {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

export type WebFetchToolResultBlockParam = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
  caller?: ToolCaller
}

export type CodeExecutionToolResultBlockParam = {
  type: 'code_execution_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

export type BashCodeExecutionToolResultBlockParam = {
  type: 'bash_code_execution_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

export type TextEditorCodeExecutionToolResultBlockParam = {
  type: 'text_editor_code_execution_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

export type ToolSearchToolResultBlockParam = {
  type: 'tool_search_tool_result'
  tool_use_id: string
  content: unknown
  cache_control?: CacheControlEphemeral | null
}

export type ContainerUploadBlockParam = {
  type: 'container_upload'
  file_id: string
  cache_control?: CacheControlEphemeral | null
}

export type MidConversationSystemBlockParam = {
  type: 'mid_conv_system'
  content: Array<TextBlockParam>
  cache_control?: CacheControlEphemeral | null
}

/** The request-side content param union (user/tool-result/media input).
 *  Settled RESPONSE blocks are admitted verbatim (`| ContentBlock`) — the
 *  wire accepts echoed assistant blocks in history, and the transcript's
 *  user rows carry them (tool-result pairing, replayed turns). */
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

/** One conversation-history row as sent on a request wire. */
export type MessageParam = {
  role: 'user' | 'assistant'
  content: string | Array<ContentBlockParam>
}

// ── tool + request descriptors ──────────────────────────────────────────────

/** Structured-output forcing descriptor (json_schema). */
export type JsonOutputFormat = {
  type: 'json_schema'
  schema: { [key: string]: unknown }
}

/** Tool-choice forcing descriptor. */
export type ToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' }

/** Extended-thinking request configuration. */
export type ThinkingConfigParam =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }

/** A JSON-Schema object-typed tool input schema (the zodToJsonSchema product). */
export type ToolInputSchema = {
  type: 'object'
  properties?: unknown | null
  required?: Array<string> | null
  [key: string]: unknown
}

/** A custom (client-executed) tool schema — the ONE zodToJsonSchema product. */
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

/** A provider-executed (server) tool descriptor (web_search etc.). */
export type ServerToolDescriptor = {
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

/** Bounded request-envelope shape for debug capture/logging surfaces (the
 *  leaf owns the full request type; these fields are what capture reads). */
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

/** What a provider stream codec ACTUALLY decodes into
 *  the canonical grammar. Surfaces read the owning codec's constant to choose
 *  a native streaming display vs a truthful waiting state — never pretending
 *  a capability the route does not decode. Each codec exports its own
 *  constant beside its fold (openaiWire · streamCore); this type is the one
 *  shared vocabulary. */
export type StreamCapabilityAdvertisement = {
  /** Assistant text streams as text_delta events. */
  textDelta: boolean
  /** Reasoning streams as thinking_delta events. */
  reasoningDelta: boolean
  /** Tool-call arguments stream live as input_json_delta before settlement. */
  toolArgsDelta: boolean
  /** Provider-reported usage settles on the turn. */
  usage: boolean
  /** First-byte/first-event timing marks are recorded. */
  timing: boolean
}

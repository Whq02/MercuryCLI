// ============================================================================
//  src/services/mcp/sdk.ts — the ONE doorway to @modelcontextprotocol/sdk.
//
//  Every static SDK import in src comes through this file, and this file is
//  re-export lines and nothing else: no wrapper, no function, no runtime
//  logic (the ruled shape — a swap of the SDK is an edit here alone). The
//  names are the SDK's own, served from our path; consumers keep their local
//  aliases. Types are `export type` (verbatimModuleSyntax). The surface is
//  exactly the set src consumes — scripts/mcp/prove-sdk-doorway.ts pins it
//  and reds any direct SDK import outside this file. The one lazy site,
//  coordinationServer.ts's dynamic import of server/mcp.js, stays direct by
//  design: a static re-export here would make the server SDK an eager edge
//  of every process.
// ============================================================================
export { Client } from '@modelcontextprotocol/sdk/client/index.js'
export {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js'
export type { AuthResult, OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
export { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export { Server } from '@modelcontextprotocol/sdk/server/index.js'
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
export {
  InvalidClientError,
  InvalidGrantError,
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
export {
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
export type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
export type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
export {
  CallToolRequestSchema,
  CallToolResultSchema,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  GetPromptResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
export type {
  CallToolResult,
  ElicitResult,
  Implementation,
  JSONRPCMessage,
  PrimitiveSchemaDefinition,
  ReadResourceResult,
  Resource,
  ServerCapabilities,
  Tool,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'

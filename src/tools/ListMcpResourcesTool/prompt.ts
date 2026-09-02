/**
 * Tool-name constant, description, and prompt for the MCP resource lister.
 */

/** Contract data: the model-visible tool name. */
export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

export const DESCRIPTION =
  'Survey the resources your connected MCP servers publish. Rows pair each protocol-defined resource field with a server field naming the origin.'

export const PROMPT = `Survey the resources your connected MCP servers publish.
Each row names its providing server in a 'server' field, beside the protocol-defined resource fields (uri, name, and optionally mimeType and description).

Parameters:
- server (optional): narrow the survey to one MCP server. Left out, every server reports.

Usage examples:
- List every resource from every server: {}
- List resources from one server: { "server": "myserver" }`

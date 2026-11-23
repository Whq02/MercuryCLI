export const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResource'


export const DESCRIPTION = `Fetch one MCP resource, addressed by server name plus resource URI.

Example call:
{ "server": "filesystem", "uri": "file:///workspace/README.md" }`

export const PROMPT = `Reads one resource from a connected MCP server and returns its contents as the server sent them: text, or the path binary content was saved to.`

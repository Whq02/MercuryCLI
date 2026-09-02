/** Static description/prompt strings for the MCP resource-read tool. */

export const DESCRIPTION = `Fetch one MCP resource, addressed by server name plus resource URI.

Example call:
{ "server": "filesystem", "uri": "file:///workspace/README.md" }`

export const PROMPT = `Read a single resource from a connected MCP server.

Parameters:
- server (required): which connected MCP server publishes the resource
- uri (required): the resource URI to fetch

The result carries the resource contents as returned by the server (text, or a note about where binary content was saved).`

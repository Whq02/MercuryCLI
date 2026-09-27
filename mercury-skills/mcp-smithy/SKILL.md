---
name: mcp-smithy
description: Use when building an MCP server for a Mercury session and proving its tool contract. Not for configuring an existing server.
argument-hint: "<purpose> [stdio|http] [python]"
---
# MCP smithy

Translate the requested operation into a small tool contract: selection description, inputs, output and failure. Inspect the project's installed SDK and its version's documentation before choosing imports or transport APIs; do not copy a recipe from another SDK generation.

For a Mercury-owned local process, use stdio and send logs to stderr. For a remote server, use Streamable HTTP with authentication and Origin/Host checks. Tool annotations describe effects; they do not authorise them. Keep credentials outside returned content.

Use the SDK client to prove initialise, discovery and a real call. Exercise malformed input and handler failure too. If advertising `outputSchema`, validate `structuredContent` against it; distinguish an `isError` tool result from a broken transport. No custom JSON-RPC prober is needed.

Only register when asked, in the agreed scope. Mercury accepts `mercury mcp add <name> --scope project -- <command> [args]` for stdio, or `mercury mcp add <name> <url> --transport http --scope project`. After operator approval, verify that Mercury discovers the expected schema and can invoke a harmless operation. Keep that integration result separate from the server's unit tests.

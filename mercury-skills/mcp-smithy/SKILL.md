---
name: mcp-smithy
description: Use when building or fixing an MCP server's tools, resources, prompts or transport. Not for configuring an existing third-party server.
argument-hint: "<purpose> [stdio|http] [python]"
---
# MCP smithy

## Define the server
- Inspect the project's SDK and transport before changing dependencies.
- For TypeScript v2, use `@modelcontextprotocol/server` with Zod 4; read `references/typescript-v2.md`.
- For Python v2, import `MCPServer` from `mcp.server`; do not use the removed `FastMCP` import.
- Give each tool a specific verb, selection description and described input fields.
- Declare `outputSchema` for structured results; return matching `structuredContent` and readable `content`.
- Return actionable tool failures as `isError: true`; distinguish them from protocol failures.
- Set read-only, destructive and idempotent annotations accurately; treat them as hints, not authorisation.
- Use resources for addressable data, resource templates for URI families and prompts for reusable messages.

## Connect and prove
- Use stdio for host-owned processes; reserve stdout for protocol traffic and stderr for logs.
- Use Streamable HTTP for remote clients; validate Origin/Host and require authentication where appropriate.
- Keep stateless handlers stateless; retain session state only when the protocol requires it.
- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Probe initialise/list/call with `node "${MERCURY_SKILL_DIR}/scripts/mcp_probe.mjs" --call greet '{"name":"Ada"}' -- node dist/index.js`; use `--self-test` to test the helper.
- Test valid input, invalid input and handler failure; use `npx @modelcontextprotocol/inspector <command>` for interactive inspection.

## Register
- Register stdio with `mercury mcp add <name> -- node dist/index.js`.
- Register HTTP with `mercury mcp add <name> <url> --transport http --scope project`.
- Use project scope for shared `.mcp.json`; keep secrets outside committed configuration.
- Confirm connection and tools in `/mcp`; document transport, requirements and registration.

## Sources
Checked: 2026-09-15. [Specification](https://modelcontextprotocol.io/specification/), [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Python SDK](https://pypi.org/project/mcp/), [Inspector](https://www.npmjs.com/package/@modelcontextprotocol/inspector).

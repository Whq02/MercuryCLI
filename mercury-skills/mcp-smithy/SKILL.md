---
name: mcp-smithy
description: Use when building an MCP server for a Mercury session and proving its tool contract. Not for configuring an existing server.
argument-hint: "<purpose> [stdio|http] [python]"
---
# MCP smithy

Define the operation's selection, inputs, output and failure. Read the installed SDK/version before choosing imports or transport APIs. Mercury's integration owner is `src/services/mcp/sdk.ts`; do not assume a recipe from another SDK generation works here.

Choose the protocol era with the client. **LIVE page read 2026-11-04:** [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) distinguishes modern 2026-07-28+ per-request metadata and server/discover from legacy 2025-11-25-and-earlier initialize. Prove the era actually supported, including transport-specific fallback when dual-era interoperability is required; a modern version error is not by itself a reason to fall back. Keep legacy initialize coverage where Mercury interoperability needs it.

Local stdio sends logs to stderr, never protocol stdout. Remote Streamable HTTP needs authentication and Origin validation; validate Host as hardening, not as an invented spec MUST. **LIVE pages read 2026-11-04:** [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). Annotations do not authorise effects; keep credentials outside returned content.

Prefer the SDK client for discovery and a real call. Select malformed input, handler failure, cancellation and partial-result cases by the tool's effects. Validate structuredContent against advertised outputSchema; distinguish isError from protocol/transport failure. Use raw framing probes only when diagnosing that boundary.

Register only when asked, in the agreed scope: `mercury mcp add <name> --scope project -- <command> [args]` or `mercury mcp add <name> <url> --transport http --scope project`. After operator approval, verify Mercury's discovered schema and a harmless invocation. Report that integration evidence separately from SDK/unit success and any unsupported era.

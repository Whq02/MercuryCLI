---
name: mcp-smithy
description: Use when building an MCP server for a Mercury session and proving its tool contract. Not for configuring an existing server.
argument-hint: "<purpose> [stdio|http] [python]"
---
# MCP smithy

Define each tool's trigger, input schema, output and failure modes. Check the installed MCP SDK version before choosing imports or transports (`src/services/mcp/sdk.ts` owns Mercury's integration, CODE inspected 2026-11-13).

Match protocol era to the client. **LIVE page read 2026-11-04:** [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) separates 2026-07-28+ per-request metadata and `server/discover` from <=2025-11-25 `initialize`. Prove the supported era (plus transport fallback when dual-era support is needed; a modern version error alone does not justify fallback) and keep legacy `initialize` where Mercury requires it.

Transports & safety (**LIVE pages read 2026-11-04:** [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)):
- Local `stdio`: write logs to `stderr`, never `stdout`.
- Streamable HTTP: enforce auth and `Origin` validation; validate `Host` as hardening (not a spec MUST).
- Annotations never grant permissions; never include credentials in returned content.

Test with the SDK client (`tools/list` + real calls), covering malformed input, handler failure, cancellation and partial results as relevant. Validate `structuredContent` against `outputSchema`, separate `isError` from protocol/transport faults, and use raw framing probes only for transport debugging.

Register only when asked, in the agreed scope: `mercury mcp add <name> --scope project -- <command> [args]` or `mercury mcp add <name> <url> --transport http --scope project`. After operator approval, verify Mercury's discovered schema and a harmless call, reporting session integration separately from SDK tests and noting any unsupported era.

---
name: mcp-smithy
description: Build, test, and register a Model Context Protocol server that gives Mercury (or any MCP host) new tools, resources, or prompts — scaffold with the current TypeScript or Python SDK, pick stdio or Streamable HTTP, return structured results, probe the server, then add it with `mercury mcp add`. Use when asked to write or fix an MCP server; not for configuring an existing third-party server.
when_to_use: The user wants to expose an API, database, file set, or internal tool to the agent over MCP, or an MCP server they wrote fails to list or call its tools.
argument-hint: "<server purpose> [--transport stdio|http] [--python]"
---

# MCP smithy

An MCP server is a small program that answers three questions over JSON-RPC:
what tools, resources, and prompts do you offer, and what happens when one is
called. Build the smallest server that answers them correctly, prove it with
the probe, then register it.

## Choose the stack (current as of August 2026)

| Stack | Package | Use when |
|---|---|---|
| TypeScript, v2 SDK | `@modelcontextprotocol/server` 2.x (`zod` 4 for schemas) | default for new servers; spec revision 2026-07-28 |
| TypeScript, v1 SDK | `@modelcontextprotocol/sdk` 1.30.x | an existing 1.x codebase; bug fixes only |
| Python | `mcp` 2.x (`FastMCP` class) | the tool's logic already lives in Python |

Pin the versions in the project manifest; do not guess from memory when the
user's project already declares one. Read `references/typescript-v2.md` for the
full v2 API shape (tools, resources, prompts, HTTP mounting) before writing code.

## Design the surface

- One tool per verb the model would say: `search-issues`, not `issues` with a
  mode flag. Name with lowercase and hyphens.
- The `description` is what the model reads to choose the tool. State what it
  returns and the one case where it is the wrong tool.
- Declare `inputSchema` with `.describe()` on every field; the SDK derives the
  JSON Schema, validates arguments, and rejects bad calls before your handler.
- Return `content` as text the model can read. When a result has a stable
  shape, add `outputSchema` and return the same value as `structuredContent`.
- Mark behaviour with `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`) so the host can decide what needs consent.
- Errors the model should react to come back as `{ isError: true, content }`;
  throw only for programming errors.
- Resources are for data the host may read on its own (files, records); use a
  `ResourceTemplate` for addressable families. Prompts are reusable message
  templates with `argsSchema`.

## Transport

- **stdio**: the host launches the process and owns its lifetime. stdout is
  the protocol channel; log with `console.error` (or Python's `logging` to
  stderr). One stray `print`/`console.log` corrupts the stream.
- **Streamable HTTP**: one endpoint many clients share. Build a fresh server
  per request from a factory, keep it stateless unless sessions are required,
  and put Host/Origin validation in front of the handler on localhost binds.

## Prove it before registering it

```bash
# stdio: initialize + tools/list, no SDK needed
node scripts/mcp_probe.mjs -- npx tsx src/index.ts
node scripts/mcp_probe.mjs --call greet '{"name":"Ada"}' -- node dist/index.js
node scripts/mcp_probe.mjs --self-test
```

The probe speaks the protocol directly, prints the advertised tools, and can
call one. Fix anything it reports before the server reaches a host. For an
interactive session use the official inspector:
`npx @modelcontextprotocol/inspector <command>`.

## Register it with Mercury

```bash
mercury mcp add <name> -- node dist/index.js            # stdio, local scope
mercury mcp add <name> -e API_KEY=… -- npx tsx src/index.ts
mercury mcp add <name> https://host.example/mcp --transport http --scope project
```

`--scope project` writes `.mcp.json` beside the code so collaborators get it;
`local` and `user` stay on this machine. Then open `/mcp` in Mercury: the
server should show connected with its tools listed. A tool that needs consent
surfaces a permission ask the first time it runs.

## Finish

- Every tool has a description, a schema with described fields, and a tested
  happy path plus one error path.
- No secrets in code: read them from the environment passed at registration.
- README states the transport, the environment it needs, and the registration
  command.

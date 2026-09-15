# TypeScript SDK v2

Checked: 2026-09-15. Use `@modelcontextprotocol/server` 2.0.0 and Zod 4.
Install with `npm install @modelcontextprotocol/server zod`.

## Stdio

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

function createServer() {
  const server = new McpServer({ name: 'echo', version: '1.0.0' })
  server.registerTool('echo', {
    description: 'Return the supplied text',
    inputSchema: z.object({ text: z.string().describe('Text to return') }),
    outputSchema: z.object({ text: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ text }) => ({
    content: [{ type: 'text', text }],
    structuredContent: { text },
  }))
  return server
}
void serveStdio(createServer)
```

## Other surfaces
- Use `StdioServerTransport` with `server.connect()` for lower-level stdio control.
- Register fixed-URI resources or `ResourceTemplate` families; return `contents` with URI, text or base64 blob and MIME type.
- Register prompts with `argsSchema`; return `messages`.
- Mount `createMcpHandler(factory)` through `toNodeHandler` from `@modelcontextprotocol/node`.
- Apply `localhostHostValidation` and `localhostOriginValidation` for loopback HTTP.
- Use the handler's `fetch` method on web-standard runtimes; call `close()` on shutdown.
- Choose `responseMode: 'auto'`, `'sse'` or `'json'`; default to `auto`.
- Exercise `listTools`, `callTool`, `readResource` and `getPrompt` through `@modelcontextprotocol/client`.

Sources: [SDK](https://github.com/modelcontextprotocol/typescript-sdk), [server package](https://registry.npmjs.org/@modelcontextprotocol%2fserver), [Node adapter](https://registry.npmjs.org/@modelcontextprotocol%2fnode).

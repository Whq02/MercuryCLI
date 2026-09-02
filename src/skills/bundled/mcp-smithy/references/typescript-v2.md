# TypeScript SDK v2 — the server API in one page

Install: `npm install @modelcontextprotocol/server zod` (plus `tsx` for a
TypeScript entry point). Schemas are Standard Schema: import Zod 4 as
`import * as z from 'zod/v4'`.

## A stdio server

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

function createServer(): McpServer {
  const server = new McpServer({ name: 'notes', version: '1.0.0' })

  server.registerTool(
    'add-note',
    {
      title: 'Add a note',
      description: 'Save one note and return its id',
      inputSchema: z.object({ text: z.string().min(1).describe('The note body') }),
      outputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ text }) => {
      const id = String(Date.now())
      return { content: [{ type: 'text', text: `saved ${id}` }], structuredContent: { id } }
    },
  )

  return server
}

void serveStdio(createServer)
console.error('notes server on stdio')
```

`serveStdio` owns stdin/stdout and calls the factory once per connection. The
lower-level form is `const transport = new StdioServerTransport();
await server.connect(transport)` from `@modelcontextprotocol/server/stdio`.

## Resources and prompts

```ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'

server.registerResource(
  'config',
  'config://app',
  { title: 'Application config', description: 'Current settings', mimeType: 'text/plain' },
  async uri => ({ contents: [{ uri: uri.href, text: 'log_level=info' }] }),
)

server.registerResource(
  'user-profile',
  new ResourceTemplate('users://{userId}/profile', { list: undefined }),
  { title: 'User profile' },
  async (uri, { userId }) => ({ contents: [{ uri: uri.href, text: `profile of ${userId}` }] }),
)

server.registerPrompt(
  'review-code',
  {
    title: 'Code review',
    description: 'Review code for defects',
    argsSchema: z.object({ code: z.string().describe('The code to review') }),
  },
  ({ code }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Review this code:\n\n${code}` } }],
  }),
)
```

A resource callback may return several `contents` entries (text and base64
`blob` with a `mimeType`). Tool results may mix `text`, `image`, `audio`,
`resource_link`, and embedded `resource` blocks.

## Streamable HTTP

```ts
import { createServer as createHttpServer } from 'node:http'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node'

const handler = createMcpHandler(({ authInfo }) => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' })
  // register tools here; the factory runs once per request, so keep it cheap
  return server
})

const nodeHandler = toNodeHandler(handler)
const validateHost = localhostHostValidation()
const validateOrigin = localhostOriginValidation()
createHttpServer((req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return
  void nodeHandler(req, res)
}).listen(3000, '127.0.0.1')

process.on('SIGINT', async () => { await handler.close(); process.exit(0) })
```

`createMcpHandler(factory, { responseMode: 'json' | 'sse' })` returns a
web-standard `fetch`; on Bun, Deno, or Workers `export default handler` is the
whole mount. Express, Fastify, and Hono have their own thin packages
(`@modelcontextprotocol/express` and friends) that arm the header checks.

## Testing from code

`@modelcontextprotocol/client` provides `Client` plus stdio and HTTP transports
so a test can `listTools()`, `callTool({ name, arguments })`, `readResource`,
and `getPrompt` against the real server. Argument validation failures arrive as
`isError: true` results with the Zod message.

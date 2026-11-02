import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export async function startFixture(port: number): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

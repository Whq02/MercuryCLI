import { createServer } from 'node:http'
import { handleCheckout, handleInvoice } from './handlers.ts'

const routes: Record<string, (body: string) => string> = {
  '/checkout': handleCheckout,
  '/invoice': handleInvoice,
}

export function startServer(port: number) {
  return createServer((req, res) => {
    const route = routes[req.url ?? '']
    if (!route) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' }).end(route(body))
      } catch (err) {
        res.writeHead(400).end(String(err))
      }
    })
  }).listen(port)
}

if (process.argv[1]?.endsWith('server.ts')) startServer(8787)

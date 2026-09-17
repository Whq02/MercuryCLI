#!/usr/bin/env bun
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'live'
const ledger = process.argv[3] ?? ''

const LIVE_IDS = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-fixture-next']

const LIST_BODY = JSON.stringify({
  object: 'list',
  data: LIVE_IDS.map(id => ({ id, object: 'model', owned_by: 'deepseek' })),
})

const BALANCE_BODY = JSON.stringify({
  is_available: true,
  balance_infos: [{ currency: 'USD', total_balance: '10.00', granted_balance: '0.00', topped_up_balance: '10.00' }],
})

const server = createServer((req, res) => {
  if (ledger) {
    try {
      appendFileSync(ledger, `${new Date().toISOString()} ${req.method} ${req.url}\n`)
    } catch {
      return
    }
  }
  const path = (req.url ?? '').split('?')[0] ?? ''
  const answer = (status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  }
  if (req.method === 'GET' && path === '/models') {
    if (mode === 'refuse') answer(503, JSON.stringify({ error: { message: 'the fixture refuses the model list' } }))
    else answer(200, LIST_BODY)
    return
  }
  if (req.method === 'GET' && path === '/user/balance') {
    answer(200, BALANCE_BODY)
    return
  }
  answer(404, JSON.stringify({ error: { message: `no fixture route for ${req.method} ${req.url}` } }))
})

function listen(port: number): void {
  server.once('error', () => {
    if (port < 34999) listen(port + 1)
    else {
      console.error('no free port in 34900-34999')
      process.exit(2)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`PORT ${port}`)
  })
}
listen(34900)

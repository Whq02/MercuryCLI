#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'

const captureFile = process.argv[2]
const catalogueFile = process.argv[3]
if (!captureFile || !catalogueFile) {
  console.error('usage: first-run-signin-fixture-server.ts <captureFile> <catalogueFile>')
  process.exit(2)
}

const record = (entry: Record<string, unknown>): void => {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: Record<string, unknown>): string => `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.fixture`
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const PENDING_POLLS = 2
const FAIL_FIRST_MODELS = process.env.FIXTURE_FAIL_FIRST_MODELS === '1'

let polls = 0
let responsesCalls = 0
let modelsCalls = 0

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    const raw = Buffer.concat(chunks).toString('utf8')
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && url.endsWith('/deviceauth/usercode')) {
      record({ kind: 'usercode', at: Date.now() })
      json(200, { user_code: 'FX-CODE', device_auth_id: 'fx-device', interval: 1 })
      return
    }
    if (req.method === 'POST' && url.endsWith('/deviceauth/token')) {
      polls += 1
      record({ kind: 'poll', poll: polls, at: Date.now() })
      if (polls <= PENDING_POLLS) {
        json(404, { error: 'authorization_pending' })
        return
      }
      json(200, { authorization_code: 'fx-code', code_verifier: 'fx-verifier' })
      return
    }
    if (req.method === 'POST' && url.endsWith('/oauth/token')) {
      record({ kind: 'token', body: raw, at: Date.now() })
      const exp = Math.floor(Date.now() / 1000) + 86_400
      json(200, {
        id_token: jwt({ email: 'sam@example.test', exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture', chatgpt_plan_type: 'plus' } }),
        access_token: jwt({ exp }),
        refresh_token: 'fx-refresh',
      })
      return
    }
    if (req.method === 'GET' && url.endsWith('/models')) {
      modelsCalls += 1
      if (FAIL_FIRST_MODELS && modelsCalls === 1) {
        record({ kind: 'models-refused', url, at: Date.now() })
        json(503, { error: 'fixture: the first list read is refused' })
        return
      }
      const fixture = JSON.parse(readFileSync(catalogueFile, 'utf8')) as { models: unknown[] }
      record({ kind: 'models', url, at: Date.now() })
      json(200, { data: fixture.models })
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      responsesCalls += 1
      const body = ((): Record<string, unknown> => {
        try {
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {}
        }
      })()
      record({ kind: 'openai', url, model: body.model, call: responsesCalls, at: Date.now() })
      const rid = `resp_fx_${responsesCalls}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        [
          sse({ type: 'response.created', response: { id: rid } }),
          sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'astra answers from the fixture' }] } }),
          sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6 } } }),
        ].join(''),
      )
      return
    }
    record({ kind: 'hit', method: req.method, url, at: Date.now() })
    json(404, {})
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log(`PORT ${typeof address === 'object' && address ? address.port : 0}`)
})

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'console-key-refusal-home-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Answer = { status: number; body: string; contentType?: string }
let answer: Answer = { status: 400, body: '{}' }
const server: Server = createServer((_req, res) => {
  res.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' })
  res.end(answer.body)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
process.env.MERCURY_CUSTOM_OAUTH_URL = `http://127.0.0.1:${port}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const oauth = await import('../../src/services/oauth/client.ts')
async function refusal(): Promise<string> {
  try {
    const key = await oauth.createAndStoreApiKey('proof-access-token')
    return `no refusal (key ${JSON.stringify(key)})`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

console.log('[1] the server\'s own sentence reaches the sign-in card')
{
  const SENTENCE = 'API key creation is disabled for this organization'
  answer = { status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: SENTENCE } }) }
  const message = await refusal()
  console.log(`  the refusal the sign-in card would show: ${JSON.stringify(message)}`)
  check('the key-creation refusal carries the server\'s own sentence', message.includes(SENTENCE), message)
  check('the refusal is not the transport\'s bare status line', !/^Request failed with status code \d+$/.test(message), message)
}

console.log('[2] the other body shapes a provider door speaks')
{
  answer = { status: 403, body: JSON.stringify({ message: 'Your role does not permit API keys' }) }
  check('a top-level message is read', (await refusal()).includes('Your role does not permit API keys'))
  answer = { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'The token has been revoked' }) }
  check('an OAuth error_description is read', (await refusal()).includes('The token has been revoked'))
}

console.log('[3] a body with no sentence keeps the transport\'s words as before')
{
  answer = { status: 500, body: 'upstream unavailable', contentType: 'text/plain' }
  const message = await refusal()
  console.log(`  no-sentence refusal: ${JSON.stringify(message)}`)
  check('a body without a message leaves the error as it was', /status code 500/.test(message), message)
}

console.log('[4] an accepted request still stores and returns the key')
{
  answer = { status: 200, body: JSON.stringify({ raw_key: 'sk-ant-proof-key-not-real' }) }
  let key: string | null | undefined
  let threw: string | null = null
  try {
    key = await oauth.createAndStoreApiKey('proof-access-token')
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('the minted key comes back', threw === null && key === 'sk-ant-proof-key-not-real', threw ?? String(key))
  answer = { status: 200, body: JSON.stringify({}) }
  check('an accepted request with no key answers null as before', (await oauth.createAndStoreApiKey('proof-access-token')) === null)
}

server.close()
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

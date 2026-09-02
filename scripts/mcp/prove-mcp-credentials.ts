#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-cred-'))

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { normalizeOAuthErrorBody, getServerKey } = await import(
  '../../src/services/mcp/auth.ts'
)
const { filterMcpServersByPolicy, dedupClaudeAiMcpServers } = await import(
  '../../src/services/mcp/config.ts'
)
const { expandEnvVarsInString } = await import(
  '../../src/services/mcp/envExpansion.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

console.log('============================================================')
console.log(' MCP credentials — normalization · identity keys · SDK pin')
console.log('============================================================')

section('normalizeOAuthErrorBody — 200-masked OAuth errors become classifiable')
{
  const mk = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status })

  let out = await normalizeOAuthErrorBody(mk(200, { error: 'invalid_grant' }))
  let parsed = JSON.parse(await out.text()) as { error?: string }
  check('200 {error:invalid_grant} → 400', out.status === 400 && !out.ok)
  check('…error preserved', parsed.error === 'invalid_grant', j(parsed))

  for (const alias of ['invalid_refresh_token', 'expired_refresh_token', 'token_expired']) {
    out = await normalizeOAuthErrorBody(mk(200, { error: alias }))
    parsed = JSON.parse(await out.text()) as { error?: string }
    check(
      `200 {error:${alias}} → 400 invalid_grant`,
      out.status === 400 && parsed.error === 'invalid_grant',
      j(parsed),
    )
  }

  out = await normalizeOAuthErrorBody(
    mk(200, { access_token: 'tok', token_type: 'Bearer' }),
  )
  check('valid tokens body passes through (still 200)', out.status === 200 && out.ok)

  out = await normalizeOAuthErrorBody(mk(200, { client_id: 'abc' }))
  check('DCR success body passes through (still 200)', out.status === 200)

  out = await normalizeOAuthErrorBody(new Response('plain', { status: 200 }))
  check('non-JSON 200 passes through', out.status === 200)

  const raw = mk(400, { error: 'invalid_grant' })
  out = await normalizeOAuthErrorBody(raw)
  check('a real 400 is returned as-is', out === raw)
}

section('getServerKey — credential identity binds name + type + url + headers')
{
  const cfg = (over: Record<string, unknown> = {}) =>
    ({ type: 'http', url: 'https://mcp.example/api', ...over }) as never
  const k1 = getServerKey('srv', cfg())
  const k2 = getServerKey('srv', cfg())
  check('stable: same config → same key', k1 === k2)
  check('key shape name|hash16', /^srv\|[0-9a-f]{16}$/.test(k1), k1)
  check('a url change mints a NEW key', getServerKey('srv', cfg({ url: 'https://mcp.example/v2' })) !== k1)
  check('a header change mints a NEW key', getServerKey('srv', cfg({ headers: { a: 'b' } })) !== k1)
  check('missing headers ≡ empty headers (the default)', getServerKey('srv', cfg({ headers: {} })) === k1)
  check('the name participates', getServerKey('other', cfg()) !== k1)
}

section('config-plane pure gates — policy filter · claude.ai dedup · env expansion')
{
  const allowed = { type: 'http', url: 'https://ok.example/x', scope: 'user' }
  const { allowed: pass } = filterMcpServersByPolicy({ ok: allowed } as never)
  check('policy filter passes an unremarkable server', 'ok' in pass, j(pass))

  const manual = { slack: { type: 'http', url: 'https://mcp.example/slack', scope: 'user' } }
  const claudeai = { 'claude.ai Slack': { type: 'claudeai-proxy', url: 'https://mcp.example/slack', scope: 'claudeai' } }
  const { servers: deduped } = dedupClaudeAiMcpServers(claudeai as never, manual as never)
  check('claude.ai connector duplicating a manual URL is suppressed', Object.keys(deduped).length === 0, j(deduped))
  const distinct = { 'claude.ai Linear': { type: 'claudeai-proxy', url: 'https://mcp.example/linear', scope: 'claudeai' } }
  const { servers: kept } = dedupClaudeAiMcpServers(distinct as never, manual as never)
  check('a distinct connector survives dedup', 'claude.ai Linear' in kept, j(kept))

  process.env.MCP_CRED_PROOF_TOKEN = 'sekret'
  const expanded = expandEnvVarsInString('Bearer ${MCP_CRED_PROOF_TOKEN}')
  check(
    'env expansion resolves ${VAR}',
    (expanded as { value?: string; expanded?: string }).value === 'Bearer sekret' ||
      (expanded as { value?: string; expanded?: string }).expanded === 'Bearer sekret' ||
      JSON.stringify(expanded).includes('Bearer sekret'),
    j(expanded),
  )
  delete process.env.MCP_CRED_PROOF_TOKEN
}

section('the SDK auth adapter pin — the exact consumed entry points')
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'mcp', 'auth.ts'),
    'utf8',
  )
  const PINNED_CLIENT_AUTH = [
    'discoverAuthorizationServerMetadata',
    'discoverOAuthServerInfo',
    'auth as sdkAuth',
    'refreshAuthorization as sdkRefreshAuthorization',
  ]
  const clientBlock = src.slice(
    src.indexOf("import {"),
    src.indexOf("from './sdk.js'"),
  )
  for (const name of PINNED_CLIENT_AUTH) {
    check(`client/auth pin: ${name}`, clientBlock.includes(name))
  }
  const clientValueImports = (clientBlock.match(/^\s{2}(?!type )[A-Za-z].*$/gm) ?? []).length
  check(
    'no unrecorded client/auth VALUE imports',
    clientValueImports === PINNED_CLIENT_AUTH.length,
    `${clientValueImports} value imports vs ${PINNED_CLIENT_AUTH.length} pinned`,
  )
  const doorway = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'mcp', 'sdk.ts'),
    'utf8',
  )
  check(
    'the SDK error classes come from server/auth/errors through the doorway (classification only)',
    src.includes('InvalidGrantError') &&
      /InvalidGrantError,[^}]*[}] from '@modelcontextprotocol[/]sdk[/]server[/]auth[/]errors[.]js'/.test(doorway),
  )
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ MCP CREDENTIALS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} MCP CREDENTIALS FAILURE(S)`)
process.exit(1)

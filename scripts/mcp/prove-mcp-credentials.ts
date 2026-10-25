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
const { filterMcpServersByPolicy, dedupAnthropicConnectors } = await import(
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
  const { servers: deduped } = dedupAnthropicConnectors(claudeai as never, manual as never)
  check('claude.ai connector duplicating a manual URL is suppressed', Object.keys(deduped).length === 0, j(deduped))
  const distinct = { 'claude.ai Linear': { type: 'claudeai-proxy', url: 'https://mcp.example/linear', scope: 'claudeai' } }
  const { servers: kept } = dedupAnthropicConnectors(distinct as never, manual as never)
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
  process.env.MCP_CRED_PROOF_TOKEN = 'sekret2'
  check('env expansion resolves ${env:VAR} the same way', expandEnvVarsInString('Bearer ${env:MCP_CRED_PROOF_TOKEN}').expanded === 'Bearer sekret2', j(expandEnvVarsInString('Bearer ${env:MCP_CRED_PROOF_TOKEN}')))
  delete process.env.MCP_CRED_PROOF_TOKEN
  const unset = expandEnvVarsInString('${env:MCP_CRED_PROOF_TOKEN}')
  check('an unset ${env:VAR} stays literal and is reported missing under its bare name', unset.expanded === '${env:MCP_CRED_PROOF_TOKEN}' && unset.missingVars.join(',') === 'MCP_CRED_PROOF_TOKEN', j(unset))
  check('${env:VAR:-x} takes the default', expandEnvVarsInString('${env:MCP_CRED_PROOF_TOKEN:-fallback}').expanded === 'fallback')
  const { getCwd } = await import('../../src/utils/cwd.ts')
  const { homedir } = await import('node:os')
  check('${workspaceFolder} is the working directory and ${userHome} the home directory', expandEnvVarsInString('${workspaceFolder}|${userHome}').expanded === `${getCwd()}|${homedir()}` && expandEnvVarsInString('${workspaceFolder}').missingVars.length === 0)
  const { parseMcpConfig } = await import('../../src/services/mcp/config.ts')
  process.env.MCP_CRED_PROOF_CLIENT = 'client-123'
  const parsed = parseMcpConfig({ configObject: { mcpServers: { remote: { type: 'http', url: 'https://mcp.example/${env:MCP_CRED_PROOF_TOKEN:-x}', oauth: { clientId: '${env:MCP_CRED_PROOF_CLIENT}', authServerMetadataUrl: 'https://auth.example/${MCP_CRED_PROOF_TENANT:-acme}/.well-known/oauth-authorization-server' } } } }, expandVars: true, scope: 'project' })
  const remoteOauth = (parsed.config?.mcpServers.remote as { oauth?: { clientId?: string; authServerMetadataUrl?: string } } | undefined)?.oauth
  check('oauth.clientId and oauth.authServerMetadataUrl expand like url and headers', remoteOauth?.clientId === 'client-123' && remoteOauth?.authServerMetadataUrl === 'https://auth.example/acme/.well-known/oauth-authorization-server', j(remoteOauth))
  delete process.env.MCP_CRED_PROOF_CLIENT
  const { MercuryMcpAuthProvider } = await import('../../src/services/mcp/auth.ts')
  const unfilled = new MercuryMcpAuthProvider('cred-proof-unfilled', { type: 'http', url: 'https://mcp.example/unfilled', oauth: { clientId: '${MCP_CLIENT_ID}' } } as never)
  check('an unfilled ${VAR} client id is treated as unset (registration runs, the placeholder is never sent)', unfilled.clientInformation() === undefined)
  const envForm = new MercuryMcpAuthProvider('cred-proof-env-form', { type: 'http', url: 'https://mcp.example/env-form', oauth: { clientId: '${env:MCP_CLIENT_ID}' } } as never)
  check('the ${env:VAR} spelling of an unfilled client id is unset too', envForm.clientInformation() === undefined)
  const filled = new MercuryMcpAuthProvider('cred-proof-filled', { type: 'http', url: 'https://mcp.example/filled', oauth: { clientId: 'real-client-id' } } as never)
  check('a real configured client id is still used', filled.clientInformation()?.client_id === 'real-client-id', j(filled.clientInformation()))
  const partial = new MercuryMcpAuthProvider('cred-proof-partial', { type: 'http', url: 'https://mcp.example/partial', oauth: { clientId: 'tenant-${MCP_CLIENT_ID}' } } as never)
  check('only a whole ${...} reference counts as unfilled; a partial one is sent as written', partial.clientInformation()?.client_id === 'tenant-${MCP_CLIENT_ID}')
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
    'the SDK OAuth error class and its code vocabulary come through the doorway (classification only)',
    src.includes('OAuthErrorCode.InvalidGrant') &&
      src.includes('OAuthErrorCode.InvalidClient') &&
      /export [{][^}]*\bOAuthError,[^}]*\bOAuthErrorCode,[^}]*[}] from '@modelcontextprotocol[/]client'/.test(doorway),
  )
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ MCP CREDENTIALS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} MCP CREDENTIALS FAILURE(S)`)
process.exit(1)

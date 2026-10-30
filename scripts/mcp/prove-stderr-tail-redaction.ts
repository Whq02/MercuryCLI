#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-stderr-redaction-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.MERCURY_MCP_TIMEOUT_MS = '1500'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { connectToServer, clearServerCache, mcpServerStderrRedactor } = await import('../../src/services/mcp/client.ts')
const { createSecretRedactor } = await import('../../src/utils/redactSecrets.ts')
type ServerConfig = import('../../src/services/mcp/types.ts').ScopedMcpServerConfig

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — stderr redaction prover exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const S = 'ABCDEF1234567890SECRET'
const T = 'abcdefghijklmnopqrstuvwxyz0123456789'
const spellings: Array<[string, string, string]> = [
  ['Authorization: Basic', `Authorization: Basic ${S}xyz`, `${S}xyz`],
  ['bearer <token>', `bearer ${S}xyz`, `${S}xyz`],
  ['X-Api-Key header', `X-Api-Key: ${S}xyz`, `${S}xyz`],
  ['api_key=', `api_key=${S}xyz`, `${S}xyz`],
  ['json access_token', `{"access_token":"${S}xyz"}`, `${S}xyz`],
  ['url userinfo', `https://user:${S}xyz@example.com/mcp`, `${S}xyz`],
  ['url query ?token=', `https://example.com/mcp?token=${S}xyz`, `${S}xyz`],
  ['Cookie header', `Cookie: session=${S}xyz`, `${S}xyz`],
  ['Proxy-Authorization', `Proxy-Authorization: Basic ${S}xyz`, `${S}xyz`],
  ['password in a dsn', `postgres://u:${S}xyz@db/x`, `${S}xyz`],
  ['ghp_ token', `boot failed token ghp_${T}`, `ghp_${T}`],
  ['sk-ant- key', `boot failed key sk-ant-api03-${T}`, `sk-ant-api03-${T}`],
  ['Bearer sk-live', `Authorization: Bearer sk-live-${T}`, `sk-live-${T}`],
]

console.log('============================================================')
console.log(' MCP connect failures — a server\'s stderr reaches the row redacted')
console.log('============================================================')

console.log('\n── §1 the scrubber, spelling by spelling ──')
{
  const redact = createSecretRedactor()
  for (const [label, line, secret] of spellings) {
    const out = redact(line)
    t(`§1 ${label}`, !out.includes(secret) && out.includes('[redacted]'), out)
  }
  t('§1 a URL keeps its host and path once the password is gone', redact(`postgres://u:${S}xyz@db/x`) === 'postgres://u:[redacted]@db/x', redact(`postgres://u:${S}xyz@db/x`))
  t('§1 a URL without a password is left alone', redact('https://git@github.com/o/r and http://127.0.0.1:8080/mcp') === 'https://git@github.com/o/r and http://127.0.0.1:8080/mcp')
  t('§1 a cookie header keeps its names', redact(`Cookie: a=${S}1; b=${S}2`) === 'Cookie: a=[redacted]; b=[redacted]', redact(`Cookie: a=${S}1; b=${S}2`))
  const joined = spellings.map(([, line]) => line).join(' · ')
  t('§1 redaction is idempotent over the joined tail', redact(redact(joined)) === redact(joined))
  const seeded = mcpServerStderrRedactor({ type: 'stdio', scope: 'dynamic', command: 'x', args: [], env: { UPSTREAM_TOKEN: 'plainvaluewithnoshape12345', MODE: 'verbose12345' } })
  t('§1 a secret-named env value of the server is known to its redactor', seeded('cannot reach upstream with plainvaluewithnoshape12345') === 'cannot reach upstream with [redacted]')
  t('§1 …an ordinary env value is not', seeded('mode is verbose12345') === 'mode is verbose12345')
  const headed = mcpServerStderrRedactor({ type: 'http', scope: 'dynamic', url: 'https://x.test/mcp', headers: { 'X-Org': 'acme-routing-key' } } as ServerConfig)
  t('§1 a configured header value is known to its redactor', headed('gateway refused acme-routing-key') === 'gateway refused [redacted]')
}

const stdio = (script: string, env: Record<string, string> = {}): ServerConfig =>
  ({ type: 'stdio', scope: 'dynamic', command: process.execPath, args: ['-e', script], env }) as ServerConfig
const failureOf = async (name: string, config: ServerConfig): Promise<string> => {
  try {
    const connection = await connectToServer(name, config)
    return connection.type === 'failed' ? (connection.error ?? '') : `connection ${connection.type}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    await clearServerCache(name, config)
  }
}

console.log('\n── §2 a server that prints a credential and exits ──')
{
  const lines = spellings.map(([, line]) => line)
  const script = `process.stderr.write(${JSON.stringify(lines.slice(-3).join('\n') + '\n')}); setTimeout(() => process.exit(1), 50)`
  const message = await failureOf('leaky-exit', stdio(script))
  const leaked = spellings.slice(-3).filter(([, , secret]) => message.includes(secret)).map(([label]) => label)
  t('§2 the connection-error line names the server stderr', message.includes('server stderr:'), message)
  t('§2 …with every credential redacted', leaked.length === 0, `leaked: ${leaked.join(', ')} in ${message}`)
  t('§2 …and the redaction marker where the value was', message.includes('[redacted]'), message)
  for (let i = 0; i < spellings.length; i += 3) {
    const batch = spellings.slice(i, i + 3)
    const text = batch.map(([, line]) => line).join('\n') + '\n'
    const out = await failureOf(`leaky-${i}`, stdio(`process.stderr.write(${JSON.stringify(text)}); setTimeout(() => process.exit(1), 50)`))
    const bad = batch.filter(([, , secret]) => out.includes(secret)).map(([label]) => label)
    t(`§2 batch ${batch.map(([label]) => label).join(' / ')}`, bad.length === 0, `leaked: ${bad.join(', ')} in ${out}`)
  }
  const echoed = await failureOf('leaky-env', stdio('process.stderr.write("upstream said no to " + process.env.UPSTREAM_TOKEN + "\\n"); setTimeout(() => process.exit(1), 50)', { UPSTREAM_TOKEN: 'plainvaluewithnoshape12345' }))
  t('§2 a server echoing its own configured token shows [redacted]', !echoed.includes('plainvaluewithnoshape12345') && echoed.includes('upstream said no to [redacted]'), echoed)
}

console.log('\n── §3 a server that prints a credential and never answers ──')
{
  const message = await failureOf('leaky-hang', stdio('process.stderr.write("Authorization: Bearer " + process.env.LEAKED_VALUE + "\\n"); setInterval(() => {}, 1000)', { LEAKED_VALUE: `${S}xyz` }))
  t('§3 the deadline line names the stderr start', message.includes('did not answer') && message.includes('stderr began:'), message)
  t('§3 …without the credential', !message.includes(`${S}xyz`) && message.includes('Bearer [redacted]'), message)
}

clearTimeout(watchdog)
console.log(failures === 0 ? '\nMCP STDERR REDACTION: ALL PASS' : `\nMCP STDERR REDACTION: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

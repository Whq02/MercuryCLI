#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-connect-reason-honesty.ts — the reason on a failed
//  connect is TRUE and names the next step, on every transport.
//
//  Driving `mcp list` against the failure shapes showed three dishonest
//  receipts: the stdio connect DEADLINE wore the close-class tail ("the
//  server wrote nothing to stderr before closing (run the command by hand
//  to see why it exits)") — the deadline ended the server, it never closed,
//  and the row then clipped mid-word at 160 characters; a command that does
//  not exist read as the same close sentence (it never ran, so "run it by
//  hand" is the wrong step); and every remote fault read `fetch failed`
//  with the real cause (connection refused, DNS, a blocked port) left on the
//  wrapper's `cause`. One composer now owns the sentence
//  (describeMcpConnectFailure); the CLI clips at a word with the cut marked;
//  the add verb lists only the scopes it can write; add-json speaks the
//  matched transport's field problems instead of `(root): Invalid input`.
//
//    §1 the composer, shape by shape (pure)
//    §2 clipToWord · ensureConfigScope · describeMcpConfigIssues (pure)
//    §3 LIVE — stdio: a command that does not exist · a server that exits
//       with stderr · a server that exits silently
//    §4 LIVE — http and sse against a loopback port nobody listens on
//
//  Hermetic: scratch config home, loopback only, MCP_TIMEOUT=1500 so no
//  leg can hang. Run: ~/.bun/bin/bun run scripts/mcp/prove-connect-reason-honesty.ts
// ============================================================================
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-reason-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
process.env.MCP_TIMEOUT = '1500'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — connect-reason prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const utils = await import('../../src/services/mcp/utils.ts')
const { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: TelemetrySafeError } = await import('../../src/utils/errors.ts')
const { McpServerConfigSchema } = await import('../../src/services/mcp/types.ts')

console.log('============================================================')
console.log(' MCP connect-failure reasons — true words, the next step named')
console.log('============================================================')

section('§1 the composer, shape by shape')
{
  const deadline = new TelemetrySafeError('MCP server "x" (stdio) did not answer in 1.5s — retry from /mcp', utils.MCP_CONNECT_TIMEOUT_TELEMETRY)
  const deadlineReason = utils.describeMcpConnectFailure(deadline, { transport: 'stdio', command: 'node', stderrTail: '' })
  t('§1 the deadline keeps its own sentence, untouched', deadlineReason === deadline.message, deadlineReason)
  t('§1 …never the close-class tail', !deadlineReason.includes('before closing') && !deadlineReason.includes('server stderr'))
  const enoent = Object.assign(new Error('spawn /nonexistent/bin/mcp-server ENOENT'), { code: 'ENOENT' })
  const enoentReason = utils.describeMcpConnectFailure(enoent, { transport: 'stdio', command: '/nonexistent/bin/mcp-server', stderrTail: '' })
  t('§1 a command that does not exist says so, names it, names the fix', enoentReason.startsWith('command not found: /nonexistent/bin/mcp-server') && enoentReason.includes('check the path') && enoentReason.includes('retry from /mcp'), enoentReason)
  t('§1 …and never "run the command by hand to see why it exits"', !enoentReason.includes('by hand'))
  const eacces = Object.assign(new Error('spawn ./srv EACCES'), { code: 'EACCES' })
  const eaccesReason = utils.describeMcpConnectFailure(eacces, { transport: 'stdio', command: './srv' })
  t('§1 a command that is not executable names the permission fix', eaccesReason.startsWith('command not executable: ./srv (EACCES)') && eaccesReason.includes('permissions'), eaccesReason)
  const closed = new Error('MCP error -32000: Connection closed')
  const withTail = utils.describeMcpConnectFailure(closed, { transport: 'stdio', command: 'node', stderrTail: 'boot failed: missing API key' })
  t('§1 a server that exited carries its last stderr words', withTail === 'MCP error -32000: Connection closed — server stderr: boot failed: missing API key', withTail)
  const silent = utils.describeMcpConnectFailure(closed, { transport: 'stdio', command: 'node', stderrTail: '' })
  t('§1 a server that exited silently says so and names the next step', silent.includes('wrote nothing to stderr before closing') && silent.includes('run the command by hand'), silent)
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:37079'), { code: 'ECONNREFUSED' }) })
  const refusedReason = utils.describeMcpConnectFailure(refused, { transport: 'http', url: 'http://127.0.0.1:37079/mcp' })
  t('§1 a refused connection names the host:port and the next step', refusedReason.startsWith('connection refused at 127.0.0.1:37079') && refusedReason.includes('nothing is listening') && refusedReason.includes('retry from /mcp'), refusedReason)
  t('§1 …never the bare wrapper', !refusedReason.includes('fetch failed'))
  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND mcp.example.invalid'), { code: 'ENOTFOUND' }) })
  const dnsReason = utils.describeMcpConnectFailure(dns, { transport: 'sse', url: 'https://mcp.example.invalid/sse' })
  t('§1 an unresolved host names DNS and the host', dnsReason.startsWith('host not found: mcp.example.invalid (DNS)'), dnsReason)
  const badPort = new Error('SSE error: TypeError: fetch failed: bad port')
  const badPortReason = utils.describeMcpConnectFailure(badPort, { transport: 'sse', url: 'http://127.0.0.1:1/sse' })
  t('§1 a blocked port names the port and the fix', badPortReason.startsWith('port 1 is on fetch') && badPortReason.includes('another port'), badPortReason)
  const cert = new TypeError('fetch failed', { cause: Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) })
  const certReason = utils.describeMcpConnectFailure(cert, { transport: 'http', url: 'https://mcp.internal:8443/mcp' })
  t('§1 an untrusted certificate names the host and NODE_EXTRA_CA_CERTS', certReason.startsWith('TLS certificate for mcp.internal not trusted') && certReason.includes('NODE_EXTRA_CA_CERTS'), certReason)
  const other = new Error('SSE error: Non-200 status code (404)')
  const otherReason = utils.describeMcpConnectFailure(other, { transport: 'sse', url: 'http://127.0.0.1:9/sse' })
  t('§1 anything else keeps its words with the class prefixes stripped', otherReason === 'SSE error: Non-200 status code (404)', otherReason)
  const wrapped = new Error('SSE error: TypeError: fetch failed: something odd')
  t('§1 …a JavaScript class name never reaches the row', !utils.describeMcpConnectFailure(wrapped, { transport: 'sse', url: 'http://127.0.0.1:9/sse' }).includes('TypeError'))
}

section('§2 clipToWord · ensureConfigScope · describeMcpConfigIssues')
{
  t('§2 a short reason passes through', utils.clipToWord('short', 160) === 'short')
  const long = 'MCP server "hangs" (stdio) did not answer in 3s — retry from /mcp — the server wrote nothing to stderr before closing (run the command by hand to see why it exits)'
  const clipped = utils.clipToWord(long, 160)
  t('§2 a long reason clips at a word and marks the cut', clipped.length <= 160 && clipped.endsWith('…') && !clipped.endsWith('exi…') && long.startsWith(clipped.slice(0, -1)), clipped)
  t('§2 a word longer than the budget still clips (the cut marked)', utils.clipToWord('x'.repeat(200), 40).length === 40)
  t('§2 the add verb accepts the three writable scopes', utils.ensureConfigScope('local') === 'local' && utils.ensureConfigScope('user') === 'user' && utils.ensureConfigScope('project') === 'project' && utils.ensureConfigScope(undefined) === 'local')
  let scopeError = ''
  try {
    utils.ensureConfigScope('enterprise')
  } catch (error) {
    scopeError = (error as Error).message
  }
  t('§2 a read-only estate is refused, and the list names only what the verb can write', scopeError === 'Invalid scope: enterprise. Valid scopes are: local, user, project', scopeError)
  const describe = (input: unknown): string => {
    const verdict = McpServerConfigSchema().safeParse(input)
    return verdict.success ? 'VALID' : utils.describeMcpConfigIssues(verdict.error.issues, input)
  }
  const http = describe({ type: 'http' })
  t('§2 add-json names the matched transport’s missing field', http.startsWith('for a http server — url:'), http)
  t('§2 …never the union’s empty verdict', !http.includes('(root)') && !http.includes('command:'), http)
  const untyped = describe({})
  t('§2 an untyped config reads as stdio and names the missing command', untyped.includes('command:') && !untyped.includes('url:'), untyped)
  const unknownType = describe({ type: 'grpc', url: 'http://127.0.0.1:1' })
  t('§2 a type no transport knows names the valid types', unknownType.startsWith('type: "grpc" is not a server type') && unknownType.includes('stdio, sse, http'), unknownType)
  t('§2 a valid config is valid', describe({ type: 'stdio', command: 'echo', args: ['j'] }) === 'VALID')
}

const mcp = await import('../../src/services/mcp/client.ts')
async function connectOnce(name: string, config: Record<string, unknown>): Promise<{ outcome: Record<string, unknown>; wallMs: number }> {
  const started = Date.now()
  const { client } = await mcp.reconnectMcpServerImpl(name, { ...config, scope: 'local' } as never)
  return { outcome: client as unknown as Record<string, unknown>, wallMs: Date.now() - started }
}
const failedReason = async (name: string, config: Record<string, unknown>): Promise<string> => {
  const { outcome } = await connectOnce(name, config)
  t(`${name}: settles failed`, outcome.type === 'failed', `type=${String(outcome.type)}`)
  return String(outcome.error ?? '')
}

section('§3 LIVE — stdio')
{
  const enoent = await failedReason('missing-command', { type: 'stdio', command: '/nonexistent/bin/mcp-server-probe', args: ['--flag'], env: {} })
  t('§3 a missing command reads "command not found" with the path and the fix', enoent.startsWith('command not found: /nonexistent/bin/mcp-server-probe') && enoent.includes('retry from /mcp'), enoent)
  const loud = await failedReason('exits-loudly', {
    type: 'stdio',
    command: process.execPath,
    args: ['-e', "process.stderr.write('boot failed: missing API key\\n'); process.exit(2)"],
    env: {},
  })
  t('§3 a server that exits with stderr carries its last words', loud.includes('server stderr: boot failed: missing API key'), loud)
  const quiet = await failedReason('exits-quietly', { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} })
  t('§3 a server that exits silently says so and names the next step', quiet.includes('wrote nothing to stderr before closing') && quiet.includes('run the command by hand'), quiet)
}

section('§4 LIVE — http and sse against a port nobody listens on')
{
  // A loopback port that is free RIGHT NOW: listen, read the port, close.
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(chosen))
    })
  })
  const http = await failedReason('refused-http', { type: 'http', url: `http://127.0.0.1:${port}/mcp` })
  t('§4 http: connection refused names the host:port and the next step', http.startsWith(`connection refused at 127.0.0.1:${port}`) && http.includes('retry from /mcp'), http)
  t('§4 http: never the bare wrapper', !http.includes('fetch failed'), http)
  const sse = await failedReason('refused-sse', { type: 'sse', url: `http://127.0.0.1:${port}/sse` })
  t('§4 sse: connection refused names the host:port and the next step', sse.startsWith(`connection refused at 127.0.0.1:${port}`) && sse.includes('retry from /mcp'), sse)
  t('§4 sse: no JavaScript class name on the row', !sse.includes('TypeError'), sse)
}

console.log(failures === 0 ? '\nPASS prove-connect-reason-honesty' : `\nFAIL prove-connect-reason-honesty (${failures})`)
process.exit(failures === 0 ? 0 : 1)

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getOriginalCwd } from '../bootstrap/state.js'
import { isPathTrusted } from '../utils/config/trust.js'
import { initialPermissionModeFromCLI } from '../utils/permissions/permissionSetup.js'
import { createMcpHandler, serveStdio, validateHostHeader, type AuthInfo } from '../services/mcp/sdk.js'
import { AutomationBridge, type AutomationOptions } from '../services/mcp/automationBridge.js'
import { automationServerFactory } from '../services/mcp/automationServer.js'
import { automationAccessSchema, clientReach, launchingSession } from '../services/mcp/automationAccess.js'
import { AutomationGateway } from '../services/mcp/automationGateway.js'

const MCP_SERVER_HELP = 'Serve Mercury tools over MCP (stdio or authenticated HTTP)'
type McpServerOptions = Omit<AutomationOptions, 'mode'> & { transport?: 'stdio' | 'http'; bind?: string; port?: number; tokenFile?: string; origin?: string; client?: string; lead?: string; coordinator?: string; maxMode?: AutomationOptions['mode'] }

async function startMcpServer(options: McpServerOptions): Promise<{ close: () => Promise<void>; url?: string }> {
  const cwd = await realpath(options.cwd ?? getOriginalCwd())
  if (!isPathTrusted(cwd)) throw new Error('Trust this folder in Mercury before starting mcp-server')
  const transport = options.transport ?? 'stdio'
  if (transport === 'stdio' && (options.bind !== undefined || options.port !== undefined || options.origin !== undefined)) throw new Error('--bind, --port and --origin require --transport http')
  const resolvedMode = initialPermissionModeFromCLI({ permissionModeCli: options.maxMode, dangerouslySkipPermissions: false })
  if (resolvedMode.notification) throw new Error(resolvedMode.notification)
  let grants: ReturnType<typeof automationAccessSchema.parse>['clients']
  if (options.tokenFile) {
    const location = relative(cwd, await realpath(options.tokenFile))
    if (location !== '..' && !location.startsWith('../') && !location.startsWith('..\\') && !isAbsolute(location)) throw new Error('Keep --token-file outside the project served by MCP')
    const info = await stat(options.tokenFile)
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('--token-file must be a private file (chmod 600)')
    grants = automationAccessSchema.parse(JSON.parse(await readFile(options.tokenFile, 'utf8'))).clients
  } else grants = [{ name: 'mcp-client', token: randomBytes(32).toString('base64url'), run: false, send: [] }]
  const roles = { lead: options.lead ?? await launchingSession(cwd), coordinator: options.coordinator }
  const factories = grants.map(grant => ({
    name: grant.name,
    expected: grant.token === undefined ? undefined : Buffer.from(`Bearer ${grant.token}`),
    factory: automationServerFactory(new AutomationBridge({ ...options, cwd, mode: resolvedMode.mode as AutomationOptions['mode'], mercury: options.mercury ?? [process.execPath, process.argv[1]!] }, clientReach(grant, roles))),
  }))
  const oauthClients = grants.flatMap(grant => grant.oauth === undefined ? [] : [{ name: grant.name, run: grant.run, send: clientReach(grant, roles).send, ...grant.oauth }])
  if (transport === 'stdio') {
    const selected = options.client ? factories.find(entry => entry.name === options.client) : factories.length === 1 ? factories[0] : undefined
    if (!selected) throw new Error('Choose a client from --token-file with --client')
    const served = serveStdio(selected.factory.create)
    return { close: async () => { await selected.factory.close(); await served.close() } }
  }
  const bind = options.bind ?? '127.0.0.1'
  const port = options.port ?? 8787
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  const publicOrigin = options.origin === undefined ? undefined : new URL(options.origin)
  if (publicOrigin && (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) throw new Error('--origin must be an HTTPS origin, without a path or credentials')
  const allowed = [...new Set(['127.0.0.1', 'localhost', bind.includes(':') ? `[${bind}]` : bind, ...(publicOrigin ? [publicOrigin.hostname] : [])])]
  const handlers = factories.map(entry => ({ ...entry, handler: createMcpHandler(entry.factory.create) }))
  const closeHandlers = async (): Promise<void> => { await Promise.all(handlers.map(async entry => { await entry.factory.close(); await entry.handler.close() })) }
  let localOrigin = ''
  let gateway: AutomationGateway | undefined
  const server = createServer(async (incoming, outgoing) => {
    const reject = (status: number, text: string): void => { outgoing.writeHead(status, { 'content-type': 'text/plain', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) }); outgoing.end(text) }
    if (!validateHostHeader(incoming.headers.host, allowed).ok) { reject(403, 'Host not allowed'); return }
    const origin = incoming.headers.origin
    if (origin !== undefined && origin !== localOrigin && origin !== publicOrigin?.origin) { reject(403, 'Origin not allowed'); return }
    const target = incoming.url ?? ''
    if (!target.startsWith('/') || target.startsWith('//')) { reject(404, 'Not found'); return }
    const controller = new AbortController()
    outgoing.once('close', () => { if (!outgoing.writableEnded) controller.abort() })
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const part of value) headers.append(key, part)
        else if (value !== undefined) headers.set(key, value)
      }
      const request = new Request(new URL(target, localOrigin), {
        method: incoming.method,
        headers,
        signal: controller.signal,
        ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' }),
      })
      const answer = async (response: Response): Promise<void> => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing)
        else outgoing.end()
      }
      const answered = await gateway?.fetch(request)
      if (answered) { await answer(answered); return }
      if (target !== '/mcp') { reject(404, 'Not found'); return }
      const authorization = Buffer.from(incoming.headers.authorization ?? '')
      let selected: typeof handlers[number] | undefined
      for (const entry of handlers) if (entry.expected && authorization.length === entry.expected.length && timingSafeEqual(authorization, entry.expected)) selected = entry
      let authInfo: AuthInfo | undefined
      if (!selected && gateway) {
        const verdict = await gateway.authenticate(request)
        if (verdict instanceof Response) { await answer(verdict); return }
        selected = handlers.find(entry => entry.name === verdict.client)
        authInfo = verdict.authInfo
      }
      if (!selected) { reject(401, 'Bearer token required'); return }
      await answer(await selected.handler.fetch(request, authInfo ? { authInfo } : undefined))
    } catch {
      if (!outgoing.headersSent) reject(500, 'MCP request failed')
      else outgoing.destroy()
    }
  })
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, options.bind ?? '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) }) }
  catch (error) { await closeHandlers(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP listener has no TCP address')
  localOrigin = `http://${bind.includes(':') ? `[${bind}]` : bind}:${address.port}`
  if (oauthClients.length > 0) {
    try { gateway = await AutomationGateway.create({ issuer: publicOrigin?.origin ?? localOrigin, clients: oauthClients, log: line => process.stderr.write(`${line}\n`) }) }
    catch (error) { await closeHandlers(); server.close(); throw error }
  }
  if (!options.tokenFile) process.stderr.write(`Bearer token: ${grants[0]!.token}\n`)
  process.stderr.write(`${localOrigin}/mcp\n`)
  return {
    url: `${localOrigin}/mcp`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await closeHandlers()
      server.closeAllConnections()
      await closed
    },
  }
}

export async function mcpServerCli(options: McpServerOptions): Promise<void> {
  const server = await startMcpServer(options)
  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    void server.close().then(() => { process.exitCode = 0 }, error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 })
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  if ((options.transport ?? 'stdio') === 'stdio') process.stdin.once('end', close)
}

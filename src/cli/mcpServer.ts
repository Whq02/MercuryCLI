import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getOriginalCwd } from '../bootstrap/state.js'
import { isPathTrusted } from '../utils/config/trust.js'
import { initialPermissionModeFromCLI } from '../utils/permissions/permissionSetup.js'
import { createMcpHandler, serveStdio, validateHostHeader } from '../services/mcp/sdk.js'
import { AutomationBridge, type AutomationOptions } from '../services/mcp/automationBridge.js'
import { automationServerFactory } from '../services/mcp/automationServer.js'

export const MCP_SERVER_HELP = 'Serve Mercury tools over MCP (stdio or authenticated HTTP)'
export type McpServerOptions = AutomationOptions & { transport?: 'stdio' | 'http'; bind?: string; port?: number; tokenFile?: string; origin?: string }

export async function startMcpServer(options: McpServerOptions): Promise<{ close: () => Promise<void>; url?: string }> {
  const cwd = options.cwd ?? getOriginalCwd()
  if (!isPathTrusted(cwd)) throw new Error('Trust this folder in Mercury before starting mcp-server')
  const transport = options.transport ?? 'stdio'
  if (transport === 'stdio' && (options.bind !== undefined || options.port !== undefined || options.tokenFile !== undefined || options.origin !== undefined)) throw new Error('--bind, --port, --token-file and --origin require --transport http')
  const resolvedMode = initialPermissionModeFromCLI({ permissionModeCli: options.mode, dangerouslySkipPermissions: false })
  if (resolvedMode.notification) throw new Error(resolvedMode.notification)
  const bridge = new AutomationBridge({ ...options, cwd, mode: resolvedMode.mode as AutomationOptions['mode'], mercury: options.mercury ?? [process.execPath, process.argv[1]!] })
  const factory = automationServerFactory(bridge)
  if (transport === 'stdio') {
    const served = serveStdio(factory.create)
    return { close: async () => { await factory.close(); await served.close() } }
  }
  const bind = options.bind ?? '127.0.0.1'
  const port = options.port ?? 8787
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  const publicOrigin = options.origin === undefined ? undefined : new URL(options.origin)
  if (publicOrigin && (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) throw new Error('--origin must be an HTTPS origin, without a path or credentials')
  let token: string
  if (options.tokenFile) {
    const location = relative(await realpath(cwd), await realpath(options.tokenFile))
    if (location !== '..' && !location.startsWith('../') && !location.startsWith('..\\') && !isAbsolute(location)) throw new Error('Keep --token-file outside the project served by MCP')
    const info = await stat(options.tokenFile)
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('--token-file must be a private file (chmod 600)')
    token = (await readFile(options.tokenFile, 'utf8')).trim()
    if (!/^[A-Za-z0-9._~+\/-]{32,}={0,2}$/.test(token)) throw new Error('--token-file must contain a bearer token of at least 32 characters')
  } else token = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  const allowed = [...new Set(['127.0.0.1', 'localhost', bind.includes(':') ? `[${bind}]` : bind, ...(publicOrigin ? [publicOrigin.hostname] : [])])]
  const handler = createMcpHandler(factory.create)
  let localOrigin = ''
  const server = createServer(async (incoming, outgoing) => {
    const reject = (status: number, text: string): void => { outgoing.writeHead(status, { 'content-type': 'text/plain', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) }); outgoing.end(text) }
    const authorization = Buffer.from(incoming.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { reject(401, 'Bearer token required'); return }
    if (!validateHostHeader(incoming.headers.host, allowed).ok) { reject(403, 'Host not allowed'); return }
    const origin = incoming.headers.origin
    if (origin !== undefined && origin !== localOrigin && origin !== publicOrigin?.origin) { reject(403, 'Origin not allowed'); return }
    if (incoming.url !== '/mcp') { reject(404, 'Not found'); return }
    const controller = new AbortController()
    outgoing.once('close', () => { if (!outgoing.writableEnded) controller.abort() })
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const part of value) headers.append(key, part)
        else if (value !== undefined) headers.set(key, value)
      }
      const request = new Request(`${localOrigin}/mcp`, {
        method: incoming.method,
        headers,
        signal: controller.signal,
        ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' }),
      })
      const response = await handler.fetch(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing)
      else outgoing.end()
    } catch {
      if (!outgoing.headersSent) reject(500, 'MCP request failed')
      else outgoing.destroy()
    }
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, bind, () => { server.removeListener('error', reject); resolve() }) })
  } catch (error) { await handler.close(); await factory.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP listener has no TCP address')
  localOrigin = `http://${bind.includes(':') ? `[${bind}]` : bind}:${address.port}`
  if (!options.tokenFile) process.stderr.write(`Bearer token: ${token}\n`)
  process.stderr.write(`${localOrigin}/mcp\n`)
  return {
    url: `${localOrigin}/mcp`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await factory.close()
      await handler.close()
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

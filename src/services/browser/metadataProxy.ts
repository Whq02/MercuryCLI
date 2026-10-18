import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type LookupFunction, type Socket } from 'node:net'
import { metadataSafeAddresses } from '../../tools/WebFetchTool/privateHost.js'

async function destination(target: URL): Promise<{ host: string; lookup: LookupFunction }> {
  const addresses = await metadataSafeAddresses(target.href)
  return { host: target.hostname.replace(/^\[|\]$/g, ''), lookup: (_hostname, options, callback) => {
    if (options.all) callback(null, addresses as never)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  } }
}

const CHROME_NET_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'ERR_CONNECTION_REFUSED',
  ECONNRESET: 'ERR_CONNECTION_RESET',
  ECONNABORTED: 'ERR_CONNECTION_ABORTED',
  ETIMEDOUT: 'ERR_CONNECTION_TIMED_OUT',
  EHOSTUNREACH: 'ERR_ADDRESS_UNREACHABLE',
  ENETUNREACH: 'ERR_ADDRESS_UNREACHABLE',
  ENOTFOUND: 'ERR_NAME_NOT_RESOLVED',
  EAI_AGAIN: 'ERR_NAME_NOT_RESOLVED',
  EPIPE: 'ERR_CONNECTION_ABORTED',
}

export function chromeNetErrorFor(code: string): string {
  return CHROME_NET_ERRORS[code] ?? 'ERR_CONNECTION_FAILED'
}

export type UpstreamUnreachable = (target: string, code: string) => void

function dropBrowserSide(incoming: IncomingMessage, outgoing: ServerResponse): void {
  const socket = incoming.socket as Socket | undefined
  if (socket !== undefined && socket !== null && typeof socket.destroy === 'function') socket.destroy()
  else outgoing.destroy()
}

export async function startMetadataProxy(onRefusal: (reason: string) => void, onUnreachable: UpstreamUnreachable = () => {}): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>()
  const unreachable = (target: string, error: unknown): void => {
    const code = (error as { code?: unknown })?.code
    onUnreachable(target, typeof code === 'string' && code.length > 0 ? code : 'EUNKNOWN')
  }
  let closed = false
  const track = (socket: Socket): Socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const refusal = (error: unknown): string => {
    const reason = error instanceof Error ? error.message : String(error)
    onRefusal(reason)
    return reason
  }
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const target = new URL(incoming.url ?? '')
      if (target.protocol !== 'http:') throw new Error('The browser proxy accepts HTTP requests or HTTPS tunnels only.')
      const checked = await destination(target)
      if (closed || outgoing.destroyed) return
      const headers = { ...incoming.headers }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const upstream = request({ hostname: checked.host, lookup: checked.lookup, port: target.port || 80, method: incoming.method, path: target.pathname + target.search, headers }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      })
      upstream.on('socket', track)
      upstream.on('error', error => {
        unreachable(target.href, error)
        dropBrowserSide(incoming, outgoing)
      })
      outgoing.on('close', () => upstream.destroy())
      incoming.pipe(upstream)
    })().catch(error => {
      outgoing.writeHead(403, { 'content-type': 'text/plain' })
      outgoing.end(refusal(error))
    })
  })
  server.on('connection', track)
  server.on('connect', (incoming, downstream, head) => {
    void (async () => {
      const target = new URL('https://' + incoming.url)
      const checked = await destination(target)
      if (closed || downstream.destroyed) return
      const upstream = track(connect({ host: checked.host, lookup: checked.lookup, autoSelectFamily: true, port: Number(target.port || 443) }))
      upstream.once('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        downstream.pipe(upstream).pipe(downstream)
      })
      upstream.on('error', error => {
        unreachable(target.origin, error)
        downstream.destroy()
      })
      downstream.on('error', () => upstream.destroy())
      downstream.on('close', () => upstream.destroy())
    })().catch(error => {
      const reason = refusal(error)
      downstream.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n${reason}`)
    })
  })
  server.on('upgrade', (incoming, downstream, head) => {
    void (async () => {
      const target = new URL(incoming.url ?? '')
      if (target.protocol !== 'http:' && target.protocol !== 'ws:') throw new Error('The browser upgrade target is not an HTTP or WebSocket URL.')
      const checked = await destination(target)
      if (closed || downstream.destroyed) return
      const upstream = track(connect({ host: checked.host, lookup: checked.lookup, autoSelectFamily: true, port: Number(target.port || 80) }))
      upstream.once('connect', () => {
        const headers = incoming.rawHeaders.flatMap((value, index, all) => index % 2 === 0 && !/^proxy-/i.test(value) ? [value + ': ' + all[index + 1]] : [])
        upstream.write(`${incoming.method} ${target.pathname + target.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
        if (head.length) upstream.write(head)
        downstream.pipe(upstream).pipe(downstream)
      })
      upstream.on('error', error => {
        unreachable(target.href, error)
        downstream.destroy()
      })
      downstream.on('error', () => upstream.destroy())
      downstream.on('close', () => upstream.destroy())
    })().catch(error => {
      refusal(error)
      downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.unref()
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The browser metadata filter could not bind its local port.')
  return { port: address.port, close: () => { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); server.close() } }
}

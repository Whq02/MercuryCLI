
import { writeSync } from 'node:fs'
import * as net from 'node:net'

const CONNECT_ATTEMPTS = 5
const CONNECT_RETRY_DELAY_MS = 250
const CONNECT_TIMEOUT_MS = 1500

export type BridgeTarget = { host: string; port: number }

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

export function parseBridgeTarget(
  raw: string | undefined,
): BridgeTarget | { error: string } {
  const trimmed = raw?.trim()
  if (!trimmed) return { error: 'missing <host:port> target' }
  const idx = trimmed.lastIndexOf(':')
  if (idx <= 0 || idx === trimmed.length - 1) {
    return { error: `malformed target '${trimmed}' — expected host:port` }
  }
  const host = trimmed.slice(0, idx)
  const port = Number(trimmed.slice(idx + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `invalid port in '${trimmed}' — expected 1-65535` }
  }
  if (!isLoopbackHost(host)) {
    return {
      error: `refusing non-loopback host '${host}' — the tcp bridge is loopback-only by design (its targets are unauthenticated editor listeners)`,
    }
  }
  return { host, port }
}

function connectOnce(target: BridgeTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function connectWithRetry(
  target: BridgeTarget,
): Promise<net.Socket | { error: string }> {
  let lastError = ''
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      return await connectOnce(target)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (attempt < CONNECT_ATTEMPTS) {
        await new Promise(res => setTimeout(res, CONNECT_RETRY_DELAY_MS))
      }
    }
  }
  return {
    error: `cannot reach ${target.host}:${target.port} after ${CONNECT_ATTEMPTS} attempts (${lastError})`,
  }
}

export async function runTcpBridgeEntry(argv: string[]): Promise<never> {
  const positional: string[] = []
  let hint = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hint') {
      hint = argv[i + 1] ?? ''
      i++
    } else if (argv[i] !== undefined) {
      positional.push(argv[i] as string)
    }
  }
  const target = parseBridgeTarget(positional[0])
  if ('error' in target) {
    try {
      writeSync(2, `mercury-tcp-bridge: ${target.error}\nusage: --mercury-tcp-bridge <host:port> [--hint <text>]\n`)
    } catch {
    }
    process.exit(2)
  }
  const socket = await connectWithRetry(target)
  if ('error' in socket) {
    try {
      writeSync(2, `mercury-tcp-bridge: ${socket.error}${hint ? ` — ${hint}` : ''}\n`)
    } catch {
    }
    process.exit(2)
  }

  socket.setNoDelay(true)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)

  socket.on('close', () => {
    process.exitCode = 0
    process.stdin.destroy()
    const backstop = setTimeout(() => process.exit(0), 1_500)
    backstop.unref?.()
  })
  socket.on('error', err => {
    try {
      writeSync(2, `mercury-tcp-bridge: socket error: ${err.message}\n`)
    } catch {
    }
    process.exit(1)
  })
  process.stdin.on('end', () => socket.end())
  process.stdin.on('error', () => socket.end())
  process.stdout.on('error', () => {
    socket.destroy()
    process.exit(1)
  })

  return new Promise<never>(() => {})
}

const directArg = process.argv[1] ?? ''
if (
  directArg.endsWith('tcpBridge/entry.ts') ||
  directArg.endsWith('tcpBridge/entry.js')
) {
  void runTcpBridgeEntry(process.argv.slice(2))
}

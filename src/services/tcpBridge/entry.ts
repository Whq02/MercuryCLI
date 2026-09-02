// mercury-tcp-bridge — a generic stdio↔TCP byte pipe for IDE-hands lanes
// whose language servers listen on a LOOPBACK TCP port instead of speaking
// stdio (the Godot editor's GDScript LSP on :6005 and its DAP on :6006 are
// the shipped consumers). Routed as `mercury --mercury-tcp-bridge <host:port>`
// in entrypoints/cli.tsx (stamp-gated, beside --lsp-ts-sidecar) and runnable
// directly for proofs (`bun run src/services/tcpBridge/entry.ts <host:port>`).
//
// Why a bridge instead of a socket transport inside LSPServerInstance /
// DapSession: both clients are hardened stdio state machines (crash
// generations, restart budgets, bounded shutdown — the audit
// fixes). A transparent child process keeps every one of those guarantees
// for TCP servers with zero client changes; a dead editor is just a child
// that exits (bounded retries, teaching stderr), which the managers already
// handle honestly.
//
// Channel purity: stdout carries ONLY socket bytes (the protocol stream).
// All human-facing text goes to stderr, which the host clients capture as
// debug/adapter output.
//
// Loopback-only BY DESIGN: the servers this bridges to (Godot editor
// listeners) are unauthenticated — refusing non-loopback hosts here means a
// misconfigured port value can never turn Mercury into a client of an
// arbitrary remote socket.

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

/** Parse `host:port` (last-colon split so `[::1]:6005` works). */
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

/**
 * Run the bridge: argv-shaped input `[<host:port>, --hint <text>?]`.
 * The optional hint is appended to the connect-failure stderr line so each
 * lane can teach its own remedy (e.g. "open the project in the Godot
 * editor"). Never resolves on success — the process lives until either side
 * closes. Exit codes: 0 clean peer close · 1 runtime socket error · 2 usage
 * or connect failure.
 */
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
      /* a closed fd must not mask the exit */
    }
    process.exit(2)
  }
  const socket = await connectWithRetry(target)
  if ('error' in socket) {
    try {
      writeSync(2, `mercury-tcp-bridge: ${socket.error}${hint ? ` — ${hint}` : ''}\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(2)
  }

  socket.setNoDelay(true)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)

  // Peer closed → exit clean AFTER stdout drains.: a
  // final LSP/DAP burst can still sit in stdout's write buffer when the
  // socket closes — process.exit() here truncated it and a graceful close
  // read as a crashed adapter. Let the loop drain naturally (the pending
  // write keeps it alive; destroying stdin releases the last read handle),
  // with a bounded hard-exit backstop for a parent that stopped reading.
  socket.on('close', () => {
    process.exitCode = 0
    process.stdin.destroy()
    const backstop = setTimeout(() => process.exit(0), 1_500)
    backstop.unref?.()
  })
  socket.on('error', err => {
    // writeSync: a win32 TTY stream write is async and the exit can
    // discard it (the failLoud discipline).
    try {
      writeSync(2, `mercury-tcp-bridge: socket error: ${err.message}\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(1)
  })
  // Host closed our stdin (client shutdown) → half-close toward the server
  // so it can flush, then the socket 'close' above exits.
  process.stdin.on('end', () => socket.end())
  process.stdin.on('error', () => socket.end())
  // Host stdout gone (parent died) → nothing left to bridge.
  process.stdout.on('error', () => {
    socket.destroy()
    process.exit(1)
  })

  // Lives until a close/error path above exits the process.
  return new Promise<never>(() => {})
}

// Direct execution (bun run …/entry.ts <host:port>) — the cli.tsx route calls
// runTcpBridgeEntry() itself, so this only fires for standalone runs.
const directArg = process.argv[1] ?? ''
if (
  directArg.endsWith('tcpBridge/entry.ts') ||
  directArg.endsWith('tcpBridge/entry.js')
) {
  void runTcpBridgeEntry(process.argv.slice(2))
}

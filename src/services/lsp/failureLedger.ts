import { createHash } from 'node:crypto'

export const LSP_TRIES_BEFORE_REFUSAL = 3

type CallEntry = { count: number; summary: string; servers: Set<string> }
type ServerEntry = { count: number; cause: string }

const calls = new Map<string, CallEntry>()
const servers = new Map<string, ServerEntry>()

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = sortKeysDeep(source[key])
    }
    return out
  }
  return value
}

export function lspCallKey(operation: string, args: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(args)) ?? 'undefined'
  return `${operation}\u0000${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

export function recordLspCallFailure(key: string, summary: string, failedServers: string[] = []): number {
  const entry = calls.get(key) ?? { count: 0, summary, servers: new Set<string>() }
  entry.count++
  entry.summary = summary
  for (const server of failedServers) entry.servers.add(server)
  calls.set(key, entry)
  return entry.count
}

export function recordLspServerFailure(server: string, cause: string): number {
  const entry = servers.get(server) ?? { count: 0, cause }
  entry.count++
  entry.cause = cause
  servers.set(server, entry)
  return entry.count
}

export function lspCallRefusal(key: string): { count: number; summary: string } | undefined {
  const entry = calls.get(key)
  if (entry === undefined || entry.count < LSP_TRIES_BEFORE_REFUSAL) return undefined
  return { count: entry.count, summary: entry.summary }
}

export function lspServerRefusal(server: string): { count: number; cause: string } | undefined {
  const entry = servers.get(server)
  if (entry === undefined || entry.count < LSP_TRIES_BEFORE_REFUSAL) return undefined
  return { count: entry.count, cause: entry.cause }
}

export function clearLspCall(key: string): void {
  calls.delete(key)
}

export function clearLspServer(server: string): void {
  servers.delete(server)
  for (const [key, entry] of calls) {
    if (entry.servers.has(server)) calls.delete(key)
  }
}

export function resetLspFailureLedger(): void {
  calls.clear()
  servers.clear()
}

export function _lspFailureLedgerForTesting(): { calls: Array<{ key: string; count: number }>; servers: Array<{ server: string; count: number }> } {
  return {
    calls: [...calls.entries()].map(([key, entry]) => ({ key, count: entry.count })),
    servers: [...servers.entries()].map(([server, entry]) => ({ server, count: entry.count })),
  }
}

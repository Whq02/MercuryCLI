import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { LSPServerManager } from './LSPServerManager.js'

export const LSP_TRIES_BEFORE_REFUSAL = 3

type CallEntry = { count: number; summary: string; situation: string; lastFailureAt: number }

const calls = new Map<string, CallEntry>()
let clock: () => number = Date.now

export function lspLedgerNow(): number {
  return clock()
}

export function _setLspLedgerClockForTesting(now?: () => number): void {
  clock = now ?? Date.now
}

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

export function lspCallKey(name: string, args: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(args)) ?? 'undefined'
  return `${name}\u0000${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

export async function lspCallSituation(namedPaths: string[], manager: LSPServerManager | undefined): Promise<string> {
  const paths = await Promise.all([...new Set(namedPaths)].sort().map(async path => {
    try {
      const value = await stat(path)
      return [path, value.isDirectory() ? 'dir' : 'file', value.size, Math.floor(value.mtimeMs)]
    } catch {
      return [path, 'absent']
    }
  }))
  const servers = [...(manager?.getAllServers().values() ?? [])].map(server => [server.name, server.state, server.generation]).sort()
  return createHash('sha256').update(JSON.stringify({ paths, servers })).digest('hex').slice(0, 16)
}

export function lspRefusalWindowMs(count: number): number {
  return Math.min(15_000 * 2 ** (count - 1), 300_000)
}

export function recordLspServerFault(key: string, summary: string, situation: string, now = lspLedgerNow()): number {
  const prior = calls.get(key)
  const count = prior?.situation === situation ? prior.count + 1 : 1
  calls.set(key, { count, summary, situation, lastFailureAt: now })
  return count
}

export function lspCallRefusal(key: string, situation: string, now = lspLedgerNow()): { count: number; summary: string; retryAt: number } | undefined {
  const entry = calls.get(key)
  if (!entry || entry.situation !== situation || entry.count < LSP_TRIES_BEFORE_REFUSAL) return undefined
  const retryAt = entry.lastFailureAt + lspRefusalWindowMs(entry.count)
  return now < retryAt ? { count: entry.count, summary: entry.summary, retryAt } : undefined
}

export function clearLspCall(key: string): void {
  calls.delete(key)
}

export function resetLspFailureLedger(): void {
  calls.clear()
}

export function _lspFailureLedgerForTesting(): Array<{ key: string } & CallEntry> {
  return [...calls].map(([key, entry]) => ({ key, ...entry }))
}

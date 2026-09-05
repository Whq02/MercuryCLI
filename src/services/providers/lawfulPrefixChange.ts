import { logForDebugging } from '../../utils/debug.js'

const pending = new Map<string, string>()
const PROCESS_WIDE = '*'
const processWideConsumedBy = new Set<string>()

export function declareLawfulPrefixChangeForEveryOwner(reason: string): void {
  pending.set(PROCESS_WIDE, reason)
  processWideConsumedBy.clear()
  logForDebugging(`preserved thinking: lawful prefix change declared for every owner: ${reason}`)
}

export function declareLawfulPrefixChange(owner: string, reason: string): void {
  pending.set(owner, reason)
  logForDebugging(`preserved thinking: lawful prefix change declared for ${owner}: ${reason}`)
}

export function consumeLawfulPrefixChange(owner: string): string | null {
  const reason = pending.get(owner)
  if (reason !== undefined) {
    pending.delete(owner)
    return reason
  }
  const shared = pending.get(PROCESS_WIDE)
  if (shared !== undefined && !processWideConsumedBy.has(owner)) {
    processWideConsumedBy.add(owner)
    return shared
  }
  return null
}

export function pendingLawfulPrefixChange(owner: string): string | null {
  const own = pending.get(owner)
  if (own !== undefined) return own
  const shared = pending.get(PROCESS_WIDE)
  return shared !== undefined && !processWideConsumedBy.has(owner) ? shared : null
}

export function resetLawfulPrefixChanges(): void {
  pending.clear()
  processWideConsumedBy.clear()
}

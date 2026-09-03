import { logForDebugging } from '../../utils/debug.js'

const pending = new Map<string, string>()

export function declareLawfulPrefixChange(owner: string, reason: string): void {
  pending.set(owner, reason)
  logForDebugging(`preserved thinking: lawful prefix change declared for ${owner}: ${reason}`)
}

export function consumeLawfulPrefixChange(owner: string): string | null {
  const reason = pending.get(owner)
  if (reason === undefined) return null
  pending.delete(owner)
  return reason
}

export function pendingLawfulPrefixChange(owner: string): string | null {
  return pending.get(owner) ?? null
}

export function resetLawfulPrefixChanges(): void {
  pending.clear()
}

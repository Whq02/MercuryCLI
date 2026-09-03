// ============================================================================
//  providers/lawfulPrefixChange — THE LAWFUL-CHANGE SEAM: the one function
//  every owner of an in-session change the OPERATOR asked for calls when
//  that change must move the prefix every thinking block is bound to (the
//  top-level system prompt, the tools array): sub-agents or workflows
//  toggled on or off, a tool set swapped, a mode flipped by a road the
//  permission context does not carry.
//
//  What a declaration does, for one conversation (its canonical owner key):
//  the next response's dropped thinking, if the API drops the blocks the
//  change invalidated, reads as LAWFUL and the receipt names `reason`
//  (thinkingBinding.ts consumes the declaration when it classifies). It
//  moves NOTHING on the wire: the tools array and the top-level system
//  prompt are frozen for the conversation's life by law (toolEconomy.ts, the
//  section cache), so the change itself must ride a new user row — a
//  system-reminder attachment — where the model reads it; a tool the change
//  forbids stays listed and refuses at call time. The declaration exists so
//  that a drop the operator's own action caused is never blamed on Mercury.
//
//  Never for a change nobody asked for — a file appearing, a server landing,
//  a clock moving: those ride a new user row and leave the prefix alone.
// ============================================================================
import { logForDebugging } from '../../utils/debug.js'

/** Reasons declared and not yet consumed, per owner (one per conversation:
 *  a later declaration before the next response replaces the earlier
 *  clause — the receipt names the newest). */
const pending = new Map<string, string>()

/**
 * Declare that the operator's action `reason` (a clause the receipt can
 * follow "after": "sub-agents were turned on", "the workflow set changed")
 * lawfully moves `owner`'s prefix from the next request on.
 */
export function declareLawfulPrefixChange(owner: string, reason: string): void {
  pending.set(owner, reason)
  logForDebugging(`preserved thinking: lawful prefix change declared for ${owner}: ${reason}`)
}

/** The declaration a conversation carries into its next response, taken
 *  once: the classifier reads it for exactly the response that follows. */
export function consumeLawfulPrefixChange(owner: string): string | null {
  const reason = pending.get(owner)
  if (reason === undefined) return null
  pending.delete(owner)
  return reason
}

/** Read without consuming (surfaces, tests). */
export function pendingLawfulPrefixChange(owner: string): string | null {
  return pending.get(owner) ?? null
}

/** Test seam: forget every pending declaration. */
export function resetLawfulPrefixChanges(): void {
  pending.clear()
}

// PO-3 / PO-12 — per-target composer drafts.
//
// One draft per conversation target (the main conversation, each viewed
// agent), keyed by stable identity: switching targets swaps the composer
// like tabs — text typed toward one destination never follows the operator
// to another, and returning to a target restores exactly what was pending
// there. Session-lifetime module state (like the helm focus store): durable
// cross-restart drafts stay the pendingInput owner's job for the MAIN
// conversation; these are the in-flight view drafts.

const drafts = new Map<string, string>()

/** The draft key for the main conversation. */
export const MAIN_DRAFT_KEY = 'main'

export function stashViewDraft(key: string, text: string): void {
  if (text) {
    drafts.set(key, text)
  } else {
    drafts.delete(key)
  }
}

export function takeViewDraft(key: string): string {
  return drafts.get(key) ?? ''
}

/** Test/prover hook: reset the store. */
export function clearViewDrafts(): void {
  drafts.clear()
}

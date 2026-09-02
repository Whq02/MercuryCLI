/**
 * Bounded store (capacity 20, newest first) of auto-mode classifier denials,
 * intended to be written by the permission path and read by the permissions
 * UI's recent-denials tab.
 *
 * Recording is currently folded off: the recorder returns immediately, so
 * the getter always yields an empty list. Both the shape and the disabled
 * behaviour are deliberate — do not re-enable without the gate decision.
 */
export type AutoModeDenial = {
  toolName: string
  display: string
  reason: string
  timestamp: number
}

const denials: AutoModeDenial[] = []

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  // Folded off — nothing is ever recorded.
  return
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return denials
}

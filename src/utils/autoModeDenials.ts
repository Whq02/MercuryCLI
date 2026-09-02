export type AutoModeDenial = {
  toolName: string
  display: string
  reason: string
  timestamp: number
}

const denials: AutoModeDenial[] = []

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  return
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return denials
}

export type CommandPopupShape = {
  view: string
  width: (hostColumns: number) => number
  rows: (terminalRows: number) => number
}

type CommandPopupClaim = { token: number; shape: CommandPopupShape; minimumRows?: number }

let claim: CommandPopupClaim | null = null
let nextToken = 1
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function claimCommandPopup(shape: CommandPopupShape): number {
  const token = nextToken
  nextToken += 1
  claim = { token, shape }
  notify()
  return token
}

export function growCommandPopup(token: number, minimumRows: number): void {
  if (claim === null || claim.token !== token || !Number.isFinite(minimumRows) || minimumRows <= (claim.minimumRows ?? 0)) return
  const previous = claim.shape.rows
  const floor = Math.floor(minimumRows)
  claim = { ...claim, minimumRows: floor, shape: { ...claim.shape, rows: terminalRows => Math.min(terminalRows - 4, Math.max(previous(terminalRows), floor)) } }
  notify()
}

export function releaseCommandPopup(token: number): void {
  if (claim === null || claim.token !== token) return
  claim = null
  notify()
}

export function commandPopupClaim(): CommandPopupClaim | null {
  return claim
}

export function subscribeCommandPopup(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

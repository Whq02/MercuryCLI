import { createSignal } from '../../platform/async/signal.js'

export type CommandPopupShape = {
  view: string
  width: (hostColumns: number) => number
  rows: (terminalRows: number) => number
  door?: 'crew'
  compact?: 'pane'
}

type CommandPopupClaim = { token: number; shape: CommandPopupShape; minimumRows?: number; leased: boolean }

let claim: CommandPopupClaim | null = null
let nextToken = 1
const changed = createSignal()

function notify(): void {
  changed.emit()
}

export function claimCommandPopup(shape: CommandPopupShape): number {
  const token = nextToken
  nextToken += 1
  claim = { token, shape, leased: true }
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

function lease(token: number, leased: boolean): void {
  if (claim === null || claim.token !== token || claim.leased === leased) return
  claim = { ...claim, leased }
  notify()
}

export function holdCommandPopup(token: number): void {
  lease(token, true)
}

export function releaseCommandPopup(token: number): void {
  lease(token, false)
}

export function commandPopupClaim(): CommandPopupClaim | null {
  return claim !== null && claim.leased ? claim : null
}

export const subscribeCommandPopup = changed.subscribe

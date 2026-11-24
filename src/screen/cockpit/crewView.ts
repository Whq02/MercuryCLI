import { createSignal } from '../../platform/async/signal.js'

let openState = false
let version = 0
const changed = createSignal()

function notify(): void {
  version += 1
  changed.emit()
}

export function openCrewView(): void {
  if (openState) return
  openState = true
  notify()
}

export function closeCrewView(): void {
  if (!openState) return
  openState = false
  notify()
}

export function isCrewViewOpen(): boolean {
  return openState
}

export function crewViewVersion(): number {
  return version
}

export const subscribeCrewView = changed.subscribe

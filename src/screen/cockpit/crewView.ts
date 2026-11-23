let openState = false
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
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

export function subscribeCrewView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let openState = false
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function openFilesMenu(): void {
  if (openState) return
  openState = true
  notify()
}

export function closeFilesMenu(): void {
  if (!openState) return
  openState = false
  notify()
}

export function isFilesMenuOpen(): boolean {
  return openState
}

export function filesMenuVersion(): number {
  return version
}

export function subscribeFilesMenu(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

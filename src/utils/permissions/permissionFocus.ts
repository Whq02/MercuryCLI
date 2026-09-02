
let mounted = 0
let notifier: ((text: string) => void) | null = null

export function registerPermissionFocusNotifier(
  fn: (text: string) => void,
): () => void {
  notifier = fn
  return () => {
    if (notifier === fn) notifier = null
  }
}

export function armPermissionFocus(): () => void {
  mounted++
  let released = false
  return () => {
    if (released) return
    released = true
    mounted = Math.max(0, mounted - 1)
  }
}

export function isPermissionFocusActive(): boolean {
  return mounted > 0
}

export function refuseGestureWhileModal(what: string): boolean {
  if (mounted <= 0) return false
  notifier?.(
    `${what} waits — answer the open question first (esc dismisses it)`,
  )
  return true
}

export function __permissionFocusResetForTest(): void {
  mounted = 0
  notifier = null
}

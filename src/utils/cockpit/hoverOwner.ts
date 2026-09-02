import { flagEnv } from '../../substrate/flagRegistry.js'

type HoverState = {
  owner: string | null
  pointerDown: boolean
  version: number
  listeners: Set<() => void>
}
const S: HoverState = ((globalThis as Record<string, unknown>).__mercuryHoverOwner ??= {
  owner: null,
  pointerDown: false,
  version: 0,
  listeners: new Set(),
}) as HoverState

function trace(ev: string, id: string | null): void {
  const p = flagEnv('MERCURY_HOVER_DEBUG')
  if (!p) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
      p,
      JSON.stringify({ ev, id, owner: S.owner, down: S.pointerDown }) + '\n',
    )
  } catch {
  }
}

function notify(): void {
  S.version++
  for (const l of S.listeners) l()
}

export function claimHover(id: string): void {
  if (S.pointerDown || S.owner === id) return
  S.owner = id
  trace('claim', id)
  notify()
}

export function releaseHover(id: string): void {
  if (S.owner !== id) {
    trace('release-miss', id)
    return
  }
  S.owner = null
  trace('release', id)
  notify()
}

export function setHoverPointerDown(down: boolean): void {
  if (S.pointerDown === down) return
  S.pointerDown = down
  if (down && S.owner !== null) {
    S.owner = null
  }
  notify()
}

export function getHoverOwner(): string | null {
  return S.owner
}

export function subscribeHover(cb: () => void): () => void {
  S.listeners.add(cb)
  return () => {
    S.listeners.delete(cb)
  }
}

export function resetHoverOwnerForTest(): void {
  S.owner = null
  S.pointerDown = false
  S.version = 0
}

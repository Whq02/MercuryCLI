import { createHash } from 'node:crypto'

export type DesktopButton = 'left' | 'right' | 'middle'
export type DesktopModifier = 'shift' | 'control' | 'alt' | 'super'
export const DESKTOP_KEY_NAMES = [
  'enter', 'tab', 'escape', 'backspace', 'delete', 'space',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'shift', 'control', 'alt', 'super',
] as const
export type DesktopNamedKey = (typeof DESKTOP_KEY_NAMES)[number]

export function isDesktopKey(key: string): boolean {
  if ((DESKTOP_KEY_NAMES as readonly string[]).includes(key)) return true
  if (key.length !== 1) return false
  const code = key.charCodeAt(0)
  return code >= 0x20 && code <= 0x7e
}

export interface DesktopPoint {
  x: number
  y: number
}

export interface DesktopBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopDisplay {
  index: number
  id: string
  originX: number
  originY: number
  width: number
  height: number
  scale: number
  primary: boolean
}

export interface DesktopDisplays {
  displays: DesktopDisplay[]
  fingerprint: string
}

export function displaysFingerprint(displays: DesktopDisplay[]): string {
  const text = displays.map(d => `${d.id}:${d.originX},${d.originY},${d.width}x${d.height}@${d.scale}`).join('|')
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export interface DesktopCapture {
  png: Buffer
  width: number
  height: number
  scale: number
  display: number
  displayId: string
  originX: number
  originY: number
  capturedAt: number
}

export function capturePixelToPoint(
  capture: Pick<DesktopCapture, 'scale' | 'originX' | 'originY'>,
  px: number,
  py: number,
): DesktopPoint {
  return { x: capture.originX + px / capture.scale, y: capture.originY + py / capture.scale }
}

export interface DesktopApplication {
  identity: string
  name: string
  pid: number | null
  title: string | null
  bounds: DesktopBounds | null
}

export interface DesktopCursor {
  x: number
  y: number
  display: number | null
}

export type DesktopGrant = 'granted' | 'denied' | 'not-required' | 'unknown'
export type DesktopSessionKind = 'desktop' | 'no-display' | 'wayland' | 'locked' | 'service' | 'unknown'

export interface DesktopPermissions {
  session: DesktopSessionKind
  screenCapture: DesktopGrant
  input: DesktopGrant
  reason: string | null
}

export interface DesktopHeld {
  buttons: DesktopButton[]
  keys: string[]
}

export type DesktopActKind = 'move' | 'down' | 'up' | 'click' | 'drag' | 'scroll' | 'keyTap' | 'keyDown' | 'keyUp' | 'type' | 'release'

export interface DesktopActReceipt {
  act: DesktopActKind
  at: DesktopPoint | null
  completedAt: number
}

export type DesktopErrorKind = 'unavailable' | 'permission' | 'session' | 'display' | 'input' | 'busy' | 'aborted' | 'defect'

export interface DesktopError {
  kind: DesktopErrorKind
  note: string
  remedy?: string
}

export type DesktopAnswer<T> = { ok: true; value: T } | { ok: false; error: DesktopError }

export function desktopAbortedAnswer<T>(): DesktopAnswer<T> {
  return { ok: false, error: { kind: 'aborted', note: 'the act was interrupted before it completed; every held key and button was released' } }
}

export interface DesktopDriverFacts {
  kind: 'native' | 'fake'
  version: string
  platform: string
  source: 'override' | 'vendored' | 'workspace' | 'fake'
}

export interface DesktopTypeOptions {
  gapMs?: number
}

export interface DesktopDriver {
  describe(): DesktopDriverFacts
  permissions(): Promise<DesktopAnswer<DesktopPermissions>>
  permissionsNow?(): DesktopAnswer<DesktopPermissions>
  requestPermissions(): Promise<DesktopAnswer<DesktopPermissions>>
  displays(): Promise<DesktopAnswer<DesktopDisplays>>
  capture(display: number, signal: AbortSignal): Promise<DesktopAnswer<DesktopCapture>>
  frontmostApplication(): Promise<DesktopAnswer<DesktopApplication>>
  ownTerminalApplication(): Promise<DesktopAnswer<DesktopApplication | null>>
  cursor(): Promise<DesktopAnswer<DesktopCursor>>
  mouseMove(to: DesktopPoint, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  mouseDown(button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  mouseUp(button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  click(at: DesktopPoint, button: DesktopButton, count: 1 | 2 | 3, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  drag(from: DesktopPoint, to: DesktopPoint, button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  scroll(at: DesktopPoint, deltaX: number, deltaY: number, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  keyTap(key: string, modifiers: DesktopModifier[], signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  keyDown(key: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  keyUp(key: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  typeText(text: string, options: DesktopTypeOptions, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>>
  held(): Promise<DesktopAnswer<DesktopHeld>>
  releaseAll(): Promise<DesktopAnswer<DesktopHeld>>
  close(): Promise<void>
}

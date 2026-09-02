
import { fluxMark } from '../flux/fluxProbe.js'
import { refuseGestureWhileModal } from '../permissions/permissionFocus.js'

export type HelmPane = 'prompt' | 'lanes' | 'telemetry'

export type HelmRow =
  | { kind: 'teammate'; id: string; label: string }
  | { kind: 'command'; command: string; label: string }
  | { kind: 'console'; label: string }
  | { kind: 'minerva'; label: string }
  | { kind: 'main'; label: string }

export type HelmRowAction =
  | { type: 'teammate'; id: string }
  | { type: 'command'; command: string }
  | { type: 'console' }
  | { type: 'minerva' }
  | { type: 'main' }

export function helmRowSig(r: HelmRow): string {
  const head =
    r.kind === 'teammate'
      ? `t:${r.id}`
      : r.kind === 'command'
        ? `c:${r.command}`
        : r.kind === 'minerva'
          ? 'k:minerva'
          : r.kind === 'main'
              ? 'k:main'
              : 'k:console'
  return `${head}:${r.label}`
}

let telemetryAvailable = true
export function setHelmTelemetryAvailable(on: boolean): void {
  telemetryAvailable = on
}
export function isHelmTelemetryAvailable(): boolean {
  return telemetryAvailable
}

let promptEmpty = true
const promptEmptyListeners = new Set<() => void>()
export function setPromptEmpty(empty: boolean): void {
  if (promptEmpty === empty) return
  promptEmpty = empty
  for (const l of promptEmptyListeners) l()
}
export function isPromptEmpty(): boolean {
  return promptEmpty
}
export function subscribePromptEmpty(listener: () => void): () => void {
  promptEmptyListeners.add(listener)
  return () => promptEmptyListeners.delete(listener)
}

let sessionRailRows = 0
const sessionRailRowsListeners = new Set<() => void>()
export function setSessionRailRows(rows: number): void {
  if (sessionRailRows === rows) return
  sessionRailRows = rows
  for (const l of sessionRailRowsListeners) l()
}
export function getSessionRailRows(): number {
  return sessionRailRows
}
export function subscribeSessionRailRows(listener: () => void): () => void {
  sessionRailRowsListeners.add(listener)
  return () => sessionRailRowsListeners.delete(listener)
}

export function nextHelmPane(p: HelmPane): HelmPane {
  if (p === 'prompt') return 'lanes'
  if (p === 'lanes') return telemetryAvailable ? 'telemetry' : 'prompt'
  return 'prompt'
}

export function helmRowAction(row: HelmRow | undefined): HelmRowAction | null {
  if (!row) return null
  if (row.kind === 'teammate') return { type: 'teammate', id: row.id }
  if (row.kind === 'console') return { type: 'console' }
  if (row.kind === 'minerva') return { type: 'minerva' }
  if (row.kind === 'main') return { type: 'main' }
  return { type: 'command', command: row.command }
}

type RailPane = 'lanes' | 'telemetry'

let focus: HelmPane = 'prompt'
const cursor: Record<RailPane, number> = { lanes: 0, telemetry: 0 }
const cursorSig: Record<RailPane, string> = { lanes: '', telemetry: '' }
const rows: Record<RailPane, HelmRow[]> = { lanes: [], telemetry: [] }
const rowsSig: Record<RailPane, string> = { lanes: '', telemetry: '' }
let version = 0
const paneVersion: Record<RailPane, number> = { lanes: 0, telemetry: 0 }
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const l of listeners) l()
}

function notifyPane(pane: RailPane): void {
  paneVersion[pane]++
  fluxMark(`helm:pane:${pane}`)
  notify()
}

function notifyFocus(): void {
  paneVersion.lanes++
  paneVersion.telemetry++
  fluxMark('helm:focus')
  notify()
}

let pendingActivation: { pane: RailPane; sig: string } | null = null

export function requestHelmRowActivationByLabel(pane: RailPane, label: string): void {
  const i = rows[pane].findIndex(r => r.label === label)
  if (i >= 0) requestHelmRowActivation(pane, i)
}

function gestureName(row: HelmRow | undefined): string {
  if (row !== undefined && 'command' in row && typeof row.command === 'string') {
    return row.command
  }
  return 'that surface'
}

export function requestHelmRowActivation(pane: RailPane, index: number): void {
  if (refuseGestureWhileModal(gestureName(rows[pane][index]))) return
  const row = rows[pane][index]
  if (!row) return
  pendingActivation = { pane, sig: helmRowSig(row) }
  notify()
}

export function setHelmCursorBySig(pane: RailPane, sig: string): void {
  const i = rows[pane].findIndex(r => helmRowSig(r) === sig)
  if (i >= 0) setHelmCursor(pane, i)
}

export function requestHelmRowActivationBySig(pane: RailPane, sig: string): void {
  const row = rows[pane].find(r => helmRowSig(r) === sig)
  if (row === undefined) return
  if (refuseGestureWhileModal(gestureName(row))) return
  pendingActivation = { pane, sig }
  notify()
}

export function consumeHelmActivation(): HelmRowAction | null {
  if (!pendingActivation) return null
  const { pane, sig } = pendingActivation
  pendingActivation = null
  const row = rows[pane].find(r => helmRowSig(r) === sig)
  return helmRowAction(row)
}

let pendingCommand: string | null = null

export function requestCommandDispatch(command: string): void {
  if (refuseGestureWhileModal(command)) return
  pendingCommand = command
  notify()
}

export function consumeCommandDispatch(): string | null {
  const c = pendingCommand
  pendingCommand = null
  return c
}

let pendingPrefill: string | null = null

export function requestPromptPrefill(text: string): void {
  if (refuseGestureWhileModal('the prompt prefill')) return
  pendingPrefill = text
  notify()
}

export function consumePromptPrefill(): string | null {
  const t = pendingPrefill
  pendingPrefill = null
  return t
}

export function subscribeHelmFocus(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getHelmVersion(): number {
  return version
}

export function getHelmLanesVersion(): number {
  return paneVersion.lanes
}

export function getHelmTelemetryVersion(): number {
  return paneVersion.telemetry
}

export function bumpHelmLanesVersion(): void {
  notifyPane('lanes')
}

export function getHelmFocus(): HelmPane {
  return focus
}

let railEnteredAt = 0

export function helmRailPastEntryBuffer(ms = 150): boolean {
  return Date.now() - railEnteredAt >= ms
}

export function setHelmFocus(p: HelmPane): void {
  if (focus === p) return
  focus = p
  if (p !== 'prompt') railEnteredAt = Date.now()
  notifyFocus()
}

export function cycleHelmFocus(): HelmPane {
  focus = nextHelmPane(focus)
  if (focus !== 'prompt') railEnteredAt = Date.now()
  notifyFocus()
  return focus
}

function clamp(pane: RailPane, i: number): number {
  const n = rows[pane].length
  return n === 0 ? 0 : Math.max(0, Math.min(n - 1, i))
}

export function getHelmCursor(pane: RailPane): number {
  return cursor[pane]
}

function stampCursorSig(pane: RailPane): void {
  const row = rows[pane][cursor[pane]]
  cursorSig[pane] = row ? helmRowSig(row) : ''
}

export function moveHelmCursor(pane: RailPane, delta: number): void {
  const next = clamp(pane, cursor[pane] + delta)
  if (next === cursor[pane]) return
  cursor[pane] = next
  stampCursorSig(pane)
  notifyPane(pane)
}

export function setHelmCursor(pane: RailPane, index: number): void {
  const next = clamp(pane, index)
  const focusChanged = focus !== pane
  if (focusChanged) {
    focus = pane
    railEnteredAt = Date.now()
  }
  if (next !== cursor[pane]) {
    cursor[pane] = next
    stampCursorSig(pane)
    notifyPane(pane)
  }
  if (focusChanged) notifyFocus()
}

export function currentHelmRow(pane: RailPane): HelmRow | undefined {
  return rows[pane][clamp(pane, cursor[pane])]
}

export function publishHelmRows(pane: RailPane, next: HelmRow[]): void {
  const sig = next.map(helmRowSig).join('|')
  if (sig === rowsSig[pane]) return
  const anchor = cursorSig[pane]
  rows[pane] = next
  rowsSig[pane] = sig
  if (anchor) {
    const anchored = next.findIndex(r => helmRowSig(r) === anchor)
    cursor[pane] = anchored >= 0 ? anchored : clamp(pane, cursor[pane])
    stampCursorSig(pane)
  } else {
    cursor[pane] = clamp(pane, cursor[pane])
  }
  notifyPane(pane)
}

export function getHelmRows(pane: RailPane): HelmRow[] {
  return rows[pane]
}

export function resetHelmFocusForTest(): void {
  focus = 'prompt'
  cursor.lanes = 0
  cursor.telemetry = 0
  cursorSig.lanes = ''
  cursorSig.telemetry = ''
  rows.lanes = []
  rows.telemetry = []
  rowsSig.lanes = ''
  rowsSig.telemetry = ''
  pendingActivation = null
  pendingCommand = null
  pendingPrefill = null
  telemetryAvailable = true
  promptEmpty = true
  railEnteredAt = 0
  version = 0
  paneVersion.lanes = 0
  paneVersion.telemetry = 0
}

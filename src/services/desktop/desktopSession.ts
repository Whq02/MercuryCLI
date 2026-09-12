import * as fs from 'node:fs'
import * as path from 'node:path'
import { canAnswerAsks, getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { isTeammate } from '../../utils/teammate.js'
import type { Message } from '../../types/message.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { COMPUTER_TOOL_NAME } from './toolName.js'

export { COMPUTER_TOOL_NAME }

export interface ScreenMap {
  toolUseId: string
  display: number
  displayId: string
  originX: number
  originY: number
  pointWidth: number
  pointHeight: number
  imageWidth: number
  imageHeight: number
  capturedAt: number
}

export interface DesktopJudgedApp {
  identity: string
  name: string
}

export interface DesktopCheckedAct {
  action: string
  app: DesktopJudgedApp
  viaGrant: boolean
}

export interface DesktopTurnHome {
  turn: string
  app: DesktopJudgedApp
}

interface OwnerDesktopState {
  approvedApps: Map<string, string>
  checkedActApp: DesktopCheckedAct | null
  screen: ScreenMap | null
  home: DesktopTurnHome | null
}

const ownerStates = new OwnerScopedStore<OwnerDesktopState>({
  name: 'desktop-sessions',
  create: () => ({ approvedApps: new Map(), checkedActApp: null, screen: null, home: null }),
  dispose: state => {
    state.approvedApps.clear()
    state.checkedActApp = null
    state.screen = null
    state.home = null
  },
  retain: state => state.checkedActApp !== null,
})
registerOwnerScopedStore(ownerStates)

export function appApproved(owner: OwnerKey, identity: string): boolean {
  return ownerStates.peek(owner)?.approvedApps.has(identity) ?? false
}

export function approveApp(owner: OwnerKey, app: DesktopJudgedApp): void {
  ownerStates.get(owner).approvedApps.set(app.identity, app.name)
}

export function approvedAppList(owner: OwnerKey): string[] {
  return [...(ownerStates.peek(owner)?.approvedApps.keys() ?? [])]
}

export function approvedApps(owner: OwnerKey): DesktopJudgedApp[] {
  const state = ownerStates.peek(owner)
  if (!state) return []
  return [...state.approvedApps].map(([identity, name]) => ({ identity, name }))
}

export function noteCheckedActApp(owner: OwnerKey, action: string, app: DesktopJudgedApp, viaGrant = false): void {
  ownerStates.get(owner).checkedActApp = { action, app: { identity: app.identity, name: app.name }, viaGrant }
}

export function consumeCheckedAct(owner: OwnerKey, action: string): DesktopCheckedAct | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  const held = state.checkedActApp
  state.checkedActApp = null
  return held !== null && held.action === action ? held : null
}

export function consumeCheckedActApp(owner: OwnerKey, action: string): DesktopJudgedApp | null {
  return consumeCheckedAct(owner, action)?.app ?? null
}

export function peekCheckedActApp(owner: OwnerKey): DesktopCheckedAct | null {
  return ownerStates.peek(owner)?.checkedActApp ?? null
}

export function turnKeyOf(context: { queryTracking?: { chainId: string }; messages?: readonly Message[] } | undefined): string {
  const chain = context?.queryTracking?.chainId
  if (typeof chain === 'string' && chain !== '') return `chain:${chain}`
  const messages = context?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (!isHumanTurn(message)) continue
    const content = message.message.content
    if (typeof content === 'string' || !content.some(block => (block as { type?: string }).type === 'tool_result')) return `message:${message.uuid}`
  }
  return ''
}

export function noteTurnHome(owner: OwnerKey, turn: string, app: DesktopJudgedApp): DesktopJudgedApp {
  const state = ownerStates.get(owner)
  if (state.home === null || state.home.turn !== turn) state.home = { turn, app: { identity: app.identity, name: app.name } }
  return state.home.app
}

export function turnHomeApp(owner: OwnerKey, turn: string): DesktopJudgedApp | null {
  const home = ownerStates.peek(owner)?.home ?? null
  return home !== null && home.turn === turn ? home.app : null
}

export function screenOf(owner: OwnerKey): ScreenMap | null {
  return ownerStates.peek(owner)?.screen ?? null
}

export function setScreen(owner: OwnerKey, map: ScreenMap): void {
  ownerStates.get(owner).screen = map
}

export function clearScreen(owner: OwnerKey): void {
  const state = ownerStates.peek(owner)
  if (state) state.screen = null
}

export const SCREENSHOT_REGISTRY_CAP = 2000

const screenshotRegistry = new Map<string, { path: string; owner: OwnerKey | null }>()

export function noteScreenshot(owner: OwnerKey | null, toolUseId: string, filePath: string): void {
  screenshotRegistry.delete(toolUseId)
  screenshotRegistry.set(toolUseId, { path: filePath, owner })
  while (screenshotRegistry.size > SCREENSHOT_REGISTRY_CAP) {
    const oldest = screenshotRegistry.keys().next().value
    if (oldest === undefined) break
    screenshotRegistry.delete(oldest)
  }
}

export function screenshotPathForToolUse(toolUseId: string): string | null {
  return screenshotRegistry.get(toolUseId)?.path ?? null
}

export function registeredScreenshotCount(): number {
  return screenshotRegistry.size
}

export function forgetDesktopOwner(owner: OwnerKey): void {
  ownerStates.dispose(owner)
  for (const [toolUseId, entry] of [...screenshotRegistry]) {
    if (entry.owner === owner) screenshotRegistry.delete(toolUseId)
  }
}

export const DESKTOP_SHOTS_DIR = 'desktop-shots'
export const DESKTOP_SHOTS_KEEP = 200

export function desktopShotsDir(): string {
  return path.join(getMercuryHome(), DESKTOP_SHOTS_DIR)
}

function unlinkQuietly(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

function shotStem(name: string): string {
  return name.endsWith('.inline') ? name.slice(0, -'.inline'.length) : name
}

export function pruneDesktopShots(dir: string, keep: number = DESKTOP_SHOTS_KEEP): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const byStem = new Map<string, string[]>()
  for (const name of names) {
    const stem = shotStem(name)
    const siblings = byStem.get(stem)
    if (siblings) siblings.push(name)
    else byStem.set(stem, [name])
  }
  const ordered = [...byStem.keys()].sort()
  const excess = ordered.length - Math.max(0, keep)
  if (excess <= 0) return 0
  let removed = 0
  for (const stem of ordered.slice(0, excess)) {
    for (const name of byStem.get(stem) ?? []) {
      if (unlinkQuietly(path.join(dir, name))) removed += 1
    }
  }
  return removed
}

export function screenshotPath(label: string): string {
  const dir = desktopShotsDir()
  fs.mkdirSync(dir, { recursive: true })
  pruneDesktopShots(dir, DESKTOP_SHOTS_KEEP - 1)
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'shot'
  return path.join(dir, `${Date.now()}-${safe}.png`)
}

export type DesktopPhase = 'idle' | 'driving'

export interface DesktopSnapshot {
  phase: DesktopPhase
  app: string | null
  identity: string | null
  startedAt: number | null
}

export interface DesktopDrivingApp {
  identity: string
  name: string
}

export type DesktopDrivingAppInput = DesktopDrivingApp | string | null

export function drivingAppOf(input: DesktopDrivingAppInput | undefined): DesktopDrivingApp | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') return input === '' ? null : { identity: '', name: input }
  return { identity: input.identity, name: input.name }
}

export function sameDrivingApp(a: DesktopDrivingApp | null, b: DesktopDrivingApp | null): boolean {
  if (a === null || b === null) return a === b
  return a.identity === b.identity && a.name === b.name
}

export const IDLE_DESKTOP_SNAPSHOT: DesktopSnapshot = { phase: 'idle', app: null, identity: null, startedAt: null }
const IDLE_SNAPSHOT = IDLE_DESKTOP_SNAPSHOT
const listeners = new Set<() => void>()
let snapshot: DesktopSnapshot = IDLE_SNAPSHOT

function publish(next: DesktopSnapshot): void {
  snapshot = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      logForDebugging(`desktop: a snapshot listener failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function subscribeDesktop(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function desktopSnapshot(): DesktopSnapshot {
  return snapshot
}

export const DRIVING_FOOTER_PREFIX = 'hands off — Mercury is driving'

export function drivingFooter(app: string | null): string {
  return `${DRIVING_FOOTER_PREFIX} ${app ?? 'the desktop'} · esc stops it`
}

export function publishDesktopDriving(app: DesktopDrivingAppInput = null): void {
  const driving = snapshot.phase === 'driving'
  const next = drivingAppOf(app)
  publish({
    phase: 'driving',
    app: next === null ? snapshot.app : next.name,
    identity: next === null ? snapshot.identity : next.identity,
    startedAt: driving ? snapshot.startedAt : Date.now(),
  })
}

export function drivingAppOfSnapshot(view: DesktopSnapshot): DesktopDrivingApp | null {
  if (view.phase !== 'driving' || view.app === null) return null
  return { identity: view.identity ?? '', name: view.app }
}

export function setDrivingApp(app: DesktopDrivingAppInput): void {
  if (snapshot.phase !== 'driving') return
  const next = drivingAppOf(app)
  if (sameDrivingApp(next, drivingAppOfSnapshot(snapshot))) return
  publish({ ...snapshot, app: next === null ? null : next.name, identity: next === null ? null : next.identity })
}

export function publishDesktopIdle(): void {
  if (snapshot.phase === 'idle') return
  publish(IDLE_SNAPSHOT)
}

export const TEAMMATE_COMPUTER_REFUSAL =
  "the Computer tool drives the operator's own screen; a teammate never drives it in this release — the main session does"
export const AGENT_COMPUTER_REFUSAL =
  "the Computer tool drives the operator's own screen; a sub-agent never carries it in this release — the main session does"
export const HEADLESS_COMPUTER_REFUSAL =
  'the Computer tool drives the screen of an interactive session; this headless run has no operator at the screen'

export function desktopPostureRefusal(context: {
  agentId?: string
  options?: { isNonInteractiveSession?: boolean }
}): string | null {
  if (isTeammate()) return TEAMMATE_COMPUTER_REFUSAL
  if (typeof context.agentId === 'string' && context.agentId !== '') return AGENT_COMPUTER_REFUSAL
  if ((context.options?.isNonInteractiveSession === true || getIsNonInteractiveSession()) && !canAnswerAsks()) return HEADLESS_COMPUTER_REFUSAL
  return null
}

const imageRefusals = new Map<string, { error: string; at: number }>()
let mainLoopModelRead: string | null = null

export function noteImageRefusal(model: string, error: string): void {
  imageRefusals.set(model, { error, at: Date.now() })
}

export function imageRefusalOf(model: string): string | null {
  return imageRefusals.get(model)?.error ?? null
}

export function imageRefusedFor(model: string): string | null {
  if (mainLoopModelRead !== null && mainLoopModelRead !== model) imageRefusals.clear()
  mainLoopModelRead = model
  return imageRefusalOf(model)
}

export function clearImageRefusal(): void {
  imageRefusals.clear()
  mainLoopModelRead = null
}

export function resetDesktopSessionForTest(): void {
  ownerStates.clearAllForShutdown()
  screenshotRegistry.clear()
  imageRefusals.clear()
  mainLoopModelRead = null
  snapshot = IDLE_SNAPSHOT
}

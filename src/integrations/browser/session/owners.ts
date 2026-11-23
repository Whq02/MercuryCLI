import { ChildProcess, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser as DriverBrowser, LaunchOptions, Page } from 'puppeteer-core'
import puppeteerPkg from 'puppeteer-core/package.json' with { type: 'json' }
import { endProcessTree, win32TaskkillCommand } from '../../../platform/processes/processGroup.js'
import { subprocessEnv } from '../../../platform/processes/subprocessEnv.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { parseOwnerKey, type OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { registerOwnerScopedStore } from '../../../engine/run-owner/ownerLifecycle.js'
import { OwnerScopedStore } from '../../../engine/run-owner/ownerScopedStore.js'
import { endTransfers, newTransferBook, sweepIncoming, type Transfer } from '../browserTransfers.js'
import { MAIN_TAB, ENDED_TABS_KEPT, type Wiring, type Hold, type Session, type CheckedTarget, type CheckedAct, type OwnerBrowserState, BROWSER_CLOSE_BOUND_MS, BROWSER_FINISH_BOUND_MS, BROWSER_IDLE_MS, EXITED, IDLE_ENDED, SELF_CLOSED } from './shapes.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { sleepSync, startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export function clearIdleLease(state: OwnerBrowserState): void {
  if (state.idleTimer !== null) stopTimeout(state.idleTimer)
  state.idleTimer = null
}

export function armIdleLease(state: OwnerBrowserState): void {
  clearIdleLease(state)
  if (state.disposed || state.activeCalls > 0 || state.launching || state.tabs.size === 0) return
  state.idleTimer = startTimeout(() => {
    state.idleTimer = null
    if (state.activeCalls > 0 || state.launching || state.tabs.size === 0) return
    if (state.transfers.list.some(transfer => transfer.state === 'pending' && Date.now() - transfer.movedAt < BROWSER_IDLE_MS)) {
      armIdleLease(state)
      return
    }
    for (const hold of [...state.holds]) {
      const leaving = [...hold.tabs].filter(session => !session.persist)
      if (leaving.length === hold.tabs.size) {
        const browser = hold.browser
        holdGone(state, hold, IDLE_ENDED)
        void closeChild(browser)
        continue
      }
      for (const session of leaving) {
        if (state.tabs.get(session.tab) === session) state.tabs.delete(session.tab)
        noteEnded(state, session.tab, IDLE_ENDED)
        void leaveHold(state, session)
      }
    }
  }, BROWSER_IDLE_MS)
  state.idleTimer.unref?.()
}

export function beginBrowserActivity(owner: OwnerKey): () => void {
  const state = ownerStates.get(owner)
  clearIdleLease(state)
  state.activeCalls++
  let released = false
  return () => {
    if (released) return
    released = true
    state.activeCalls--
    armIdleLease(state)
  }
}

export type CloseOutcome = 'closed' | 'killed' | 'unfinished' | 'gone'

export function tempProfileDirOf(browser: DriverBrowser): string | null {
  const args = browser.process()?.spawnargs ?? []
  const arg = args.find(a => a.startsWith('--user-data-dir='))
  if (arg === undefined) return null
  const dir = arg.slice('--user-data-dir='.length)
  return /^puppeteer_dev_[a-z]+_profile-/.test(path.basename(dir)) ? dir : null
}

const TEMP_PROFILE_EXIT_BOUND_MS = 2_000
const TEMP_PROFILE_EXIT_STEP_MS = 50
export const tempProfiles = new Map<string, DriverBrowser>()

export function removeTempProfile(browser: DriverBrowser): boolean {
  const dir = tempProfileDirOf(browser)
  if (dir === null) return false
  if (!fs.existsSync(dir)) {
    tempProfiles.delete(dir)
    return false
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    passedOver(error)
    return false
  }
  if (fs.existsSync(dir)) return false
  tempProfiles.delete(dir)
  return true
}

function endTempTree(browser: DriverBrowser): void {
  const child = browser.process()
  const pid = child?.pid
  let lives = false
  try {
    lives = process.platform === 'win32' && child !== null && pid !== undefined && child.exitCode === null && child.signalCode === null && process.kill(pid, 0)
  } catch (error) {
    lives = (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (lives) {
    const { file, args } = win32TaskkillCommand(pid!)
    try {
      spawnSync(file, args, { windowsHide: true, stdio: 'ignore', timeout: TEMP_PROFILE_EXIT_BOUND_MS, env: subprocessEnv() })
    } catch (error) { passedOver(error) }
  }
  killChild(browser)
}

function clearTempProfilesAtExit(): void {
  const until = Date.now() + TEMP_PROFILE_EXIT_BOUND_MS
  for (;;) {
    for (const browser of [...tempProfiles.values()]) removeTempProfile(browser)
    if (tempProfiles.size === 0 || Date.now() >= until) return
    sleepSync(TEMP_PROFILE_EXIT_STEP_MS)
  }
}

function killChild(browser: DriverBrowser): void {
  const child = browser.process()
  if (!child) return
  try {
    child.kill('SIGKILL')
  } catch (error) {
    passedOver(error)
    return
  }
}

async function endChild(browser: DriverBrowser): Promise<void> {
  const child = browser.process()
  if (!child) return
  if (child instanceof ChildProcess) {
    await endProcessTree(child, 'SIGKILL')
    removeTempProfile(browser)
    return
  }
  killChild(browser)
  removeTempProfile(browser)
}

export function childGone(browser: DriverBrowser): boolean {
  if (browser.connected === false) return true
  const child = browser.process()
  if (child === null || child === undefined) return false
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

export async function closeChild(browser: DriverBrowser): Promise<CloseOutcome> {
  if (childGone(browser)) {
    await endChild(browser)
    return 'gone'
  }
  try {
    const quit = browser.close().then(() => 'closed' as const)
    let won: 'closed' | 'lapsed' = await withDeadline(quit, BROWSER_CLOSE_BOUND_MS, () => 'lapsed' as const)
    const quitting = won === 'lapsed' && browser.connected === false
    if (quitting) won = await withDeadline(quit, BROWSER_FINISH_BOUND_MS - BROWSER_CLOSE_BOUND_MS, () => 'lapsed' as const)
    if (won === 'lapsed') {
      await endChild(browser)
      return quitting ? 'unfinished' : 'killed'
    }
    removeTempProfile(browser)
    return 'closed'
  } catch {
    await endChild(browser)
    return 'killed'
  }
}

export async function closePage(page: Page): Promise<void> {
  if (typeof page.close !== 'function') return
  await withDeadline(page.close().catch(passedOverAs(undefined)), BROWSER_CLOSE_BOUND_MS, () => undefined)
}

export type LaunchDriver = (options: LaunchOptions) => Promise<DriverBrowser>
export let launchDriverForProof: LaunchDriver | null = null
export function setBrowserLaunchDriverForProof(driver: LaunchDriver | null): void {
  launchDriverForProof = driver
}

export const ownerStates = new OwnerScopedStore<OwnerBrowserState>({
  name: 'browser-sessions',
  live: true,
  create: () => ({
    tabs: new Map(),
    holds: new Set(),
    ended: new Map(),
    emulated: new Map(),
    pages: 0,
    popups: 0,
    transfers: newTransferBook(),
    launching: false,
    launchFlight: null,
    disposed: false,
    approvedOrigins: new Set(),
    approvedSecretPairings: new Set(),
    checkedActOrigin: null,
    goneAt: null,
    activeCalls: 0,
    idleTimer: null,
  }),
  dispose: async state => {
    state.disposed = true
    state.emulated.clear()
    clearIdleLease(state)
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
    state.checkedActOrigin = null
    if (state.launchFlight !== null) await state.launchFlight.flight.catch(passedOverAs(undefined))
    const holds = [...state.holds]
    for (const session of state.tabs.values()) session.left = true
    state.tabs.clear()
    state.holds.clear()
    for (const hold of holds) {
      closeHoldNetwork(hold)
      endDownloads(state, hold)
    }
    await Promise.all(holds.map(hold => closeChild(hold.browser)))
    await Promise.all(holds.map(hold => sweepDownloads(state, hold)))
  },
  retain: state => state.tabs.size > 0 || state.launching || state.activeCalls > 0 || state.transfers.list.some(transfer => transfer.state === 'pending'),
})
registerOwnerScopedStore(ownerStates)

let exitHookInstalled = false

export function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const browser of tempProfiles.values()) endTempTree(browser)
    for (const key of ownerStates.owners()) {
      for (const hold of ownerStates.peek(key)?.holds ?? []) {
        closeHoldNetwork(hold)
        killChild(hold.browser)
      }
    }
    clearTempProfilesAtExit()
  })
}

export async function disposeBrowserOwner(owner: OwnerKey): Promise<void> {
  await ownerStates.disposeAsync(owner)
}

export function browserSessionCap(): number | null {
  const raw = flagEnv('MERCURY_BROWSER_MAX_SESSIONS')
  if (raw === undefined || raw.trim() === '') return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function liveBrowserSessionCensus(): Array<{ owner: OwnerKey; lane: string; url: string | null }> {
  const rows: Array<{ owner: OwnerKey; lane: string; url: string | null }> = []
  for (const owner of ownerStates.owners()) {
    const state = ownerStates.peek(owner)
    if (!state) continue
    const live = [...state.holds].some(hold => hold.browser.connected)
    if (!live && !state.launching) continue
    let lane = 'unknown'
    try {
      lane = parseOwnerKey(owner).lane
    } catch (error) {
      passedOver(error)
    }
    const shown = state.tabs.get(MAIN_TAB) ?? [...state.tabs.values()][0]
    rows.push({ owner, lane, url: live && shown !== undefined ? shown.page.url() : null })
  }
  return rows
}

export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : u.protocol
  } catch (error) {
    passedOver(error)
    return 'unparseable:'
  }
}

export function noteCheckedActOrigin(owner: OwnerKey, op: string, origin: string, bound: CheckedTarget | null = null): void {
  ownerStates.get(owner).checkedActOrigin = { op, origin, bound }
}

export function consumeCheckedActOrigin(owner: OwnerKey, op: string): CheckedAct | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  const held = state.checkedActOrigin
  state.checkedActOrigin = null
  return held !== null && held.op === op ? held : null
}

export function noteEmulatedPage(owner: OwnerKey, page: Page | null, tab: string = MAIN_TAB): void {
  const state = page === null ? ownerStates.peek(owner) : ownerStates.get(owner)
  if (!state) return
  if (page === null) state.emulated.delete(tab)
  else state.emulated.set(tab, page)
}

export function emulatedPageOf(owner: OwnerKey, tab: string = MAIN_TAB): Page | null {
  return ownerStates.peek(owner)?.emulated.get(tab) ?? null
}

export function originApproved(owner: OwnerKey, origin: string): boolean {
  return ownerStates.peek(owner)?.approvedOrigins.has(origin) ?? false
}

export function approveWebOrigin(owner: OwnerKey, url: string): void {
  const origin = originOf(url)
  if (origin.startsWith('http')) ownerStates.get(owner).approvedOrigins.add(origin)
}

export function approvedOriginList(owner: OwnerKey): string[] {
  return [...(ownerStates.peek(owner)?.approvedOrigins ?? [])]
}

export function closeHoldNetwork(hold: Hold): void {
  const via: { closeNetwork: () => void } = [...hold.tabs][0] ?? hold
  via.closeNetwork()
}

export function noteEnded(state: OwnerBrowserState, tab: string, reason: string): void {
  state.ended.delete(tab)
  state.ended.set(tab, reason)
  if (state.ended.size > ENDED_TABS_KEPT) state.ended.delete(state.ended.keys().next().value!)
}

function sessionOver(state: OwnerBrowserState, gone: boolean): void {
  clearIdleLease(state)
  state.approvedOrigins.clear()
  state.approvedSecretPairings.clear()
  state.checkedActOrigin = null
  state.ended.clear()
  state.popups = 0
  if (gone) state.goneAt = Date.now()
}

export function endDownloads(state: OwnerBrowserState, hold: Hold): void {
  endTransfers(state.transfers, hold.arriving.keys(), 'its browser closed before the file was whole')
}

export async function sweepDownloads(state: OwnerBrowserState, hold: Hold): Promise<void> {
  if (hold.downloads !== null) await sweepIncoming(state.transfers, hold.downloads.home, hold.downloads.staging, () => state.holds.size === 0 && !state.launching)
}

export function holdGone(state: OwnerBrowserState, hold: Hold, reason: string): void {
  if (!state.holds.has(hold)) return
  state.holds.delete(hold)
  closeHoldNetwork(hold)
  endDownloads(state, hold)
  for (const session of hold.tabs) {
    session.left = true
    if (state.tabs.get(session.tab) === session) state.tabs.delete(session.tab)
    noteEnded(state, session.tab, reason)
  }
  hold.tabs.clear()
  if (state.tabs.size === 0) sessionOver(state, true)
  void sweepDownloads(state, hold)
}

export function reapDeadHolds(state: OwnerBrowserState): void {
  for (const hold of [...state.holds]) {
    if (childGone(hold.browser)) holdGone(state, hold, EXITED)
  }
}

export const sessionHolds = new WeakMap<Session, Hold>()
export const sessionWirings = new WeakMap<Session, Wiring>()

export function holdOf(session: Session): Hold {
  return sessionHolds.get(session)!
}

export async function leaveHold(state: OwnerBrowserState, session: Session, moved = false): Promise<CloseOutcome> {
  const hold = holdOf(session)
  session.left = true
  hold.tabs.delete(session)
  for (const [id, owned] of hold.owned) {
    if (owned === session) hold.owned.delete(id)
  }
  if (hold.front === session) hold.front = null
  if (hold.tabs.size === 0 && hold.creating === 0) {
    if (moved && hold.arriving.size > 0) return 'closed'
    state.holds.delete(hold)
    session.closeNetwork()
    endDownloads(state, hold)
    const outcome = await closeChild(hold.browser)
    await sweepDownloads(state, hold)
    return outcome
  }
  await closePage(session.page)
  return 'closed'
}

export function tabClosed(state: OwnerBrowserState, session: Session): void {
  if (session.left) return
  if (childGone(session.browser)) {
    holdGone(state, holdOf(session), EXITED)
    return
  }
  if (state.tabs.get(session.tab) === session) state.tabs.delete(session.tab)
  noteEnded(state, session.tab, SELF_CLOSED)
  void leaveHold(state, session)
  if (state.tabs.size === 0 && !state.launching) sessionOver(state, false)
}

export function activeSession(owner: OwnerKey, tab: string = MAIN_TAB): Session | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  reapDeadHolds(state)
  return state.tabs.get(tab) ?? null
}

export function browserTransfers(owner: OwnerKey): Transfer[] {
  return ownerStates.peek(owner)?.transfers.list ?? []
}

export function browserTabs(owner: OwnerKey): Session[] {
  const state = ownerStates.peek(owner)
  if (!state) return []
  reapDeadHolds(state)
  return [...state.tabs.values()]
}

export function endedTab(owner: OwnerKey, tab: string): string | null {
  return ownerStates.peek(owner)?.ended.get(tab) ?? null
}

export function sessionGoneAt(owner: OwnerKey): number | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  reapDeadHolds(state)
  return state.tabs.size === 0 ? state.goneAt : null
}

export function driverVersion(): string {
  return (puppeteerPkg as { version?: string }).version ?? 'bundled'
}

export function secretPairingKey(ref: string, origin: string): string {
  return `${ref}@${origin}`
}

export function secretPairingApproved(owner: OwnerKey, ref: string, origin: string): boolean {
  return ownerStates.peek(owner)?.approvedSecretPairings.has(secretPairingKey(ref, origin)) ?? false
}

export function approveSecretPairing(owner: OwnerKey, ref: string, origin: string): void {
  if (origin.startsWith('http')) ownerStates.get(owner).approvedSecretPairings.add(secretPairingKey(ref, origin))
}

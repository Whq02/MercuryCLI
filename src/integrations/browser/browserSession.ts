
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
export type { ConsoleEntry, NavFailure, DownloadNotice, PopupNote, CheckedTarget, EnsureSessionRefusal, EnsureBrowserSessionOptions, PageIdentity, PagePresented, PageKit } from './session/shapes.js'
export { CONSOLE_RING_CAP, CONSOLE_ENTRY_CAP, MAIN_TAB, isBrowserErrorPage, BROWSER_CLOSE_BOUND_MS, BROWSER_FINISH_BOUND_MS, BROWSER_PROTOCOL_TIMEOUT_MS, NAVIGATION_CAP_MS } from './session/shapes.js'
export type { CloseOutcome } from './session/owners.js'
export { beginBrowserActivity, tempProfileDirOf, removeTempProfile, childGone, setBrowserLaunchDriverForProof, disposeBrowserOwner, browserSessionCap, liveBrowserSessionCensus, originOf, noteCheckedActOrigin, consumeCheckedActOrigin, noteEmulatedPage, emulatedPageOf, originApproved, approveWebOrigin, approvedOriginList, activeSession, browserTransfers, browserTabs, endedTab, sessionGoneAt, driverVersion, secretPairingKey, secretPairingApproved, approveSecretPairing } from './session/owners.js'
export { resolveHostLanguages, resolveNavigatorPlatform, pageKitOf } from './session/stealth.js'
export { presentToFrames, sessionOfFrame } from './session/births.js'
export { browserProfileDirForOrigin, ensureBrowserSession, closeBrowserSession, closeBrowserSessionDetailed } from './session/launch.js'
export { firstNavigation, popupInFlight, popupsSettled, bringTabToFront } from './session/navigation.js'

export function screenshotPath(label: string): string {
  const dir = path.join(getMercuryHome(), 'browser-shots')
  fs.mkdirSync(dir, { recursive: true })
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'shot'
  return path.join(dir, `${Date.now()}-${safe}.png`)
}

import { notBuilt, type Unbuilt } from '../pi/holes.js'

type SessionActivityReason = Unbuilt

export function sendSessionActivitySignal(): void {
  return notBuilt('src/utils/sessionActivity.ts:14')
}

export function isSessionActivityTrackingActive(): boolean {
  return notBuilt('src/utils/sessionActivity.ts:18')
}

export function startSessionActivity(reason: SessionActivityReason): void {
  return notBuilt('src/utils/sessionActivity.ts:22')
}

export function stopSessionActivity(reason: SessionActivityReason): void {
  return notBuilt('src/utils/sessionActivity.ts:38')
}

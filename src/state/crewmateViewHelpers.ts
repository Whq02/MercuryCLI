import { notBuilt, type Unbuilt } from '../pi/holes.js'

type SetAppState = (...args: Unbuilt[]) => Unbuilt

export function enterCrewmateView(taskId: string, setAppState: SetAppState): void {
  return notBuilt('src/state/crewmateViewHelpers.ts:34')
}

export function exitCrewmateView(setAppState: SetAppState): void {
  return notBuilt('src/state/crewmateViewHelpers.ts:83')
}

export function setMainChat(taskId: string, setAppState: SetAppState): void {
  return notBuilt('src/state/crewmateViewHelpers.ts:104')
}

export function clearMainChat(setAppState: SetAppState): void {
  return notBuilt('src/state/crewmateViewHelpers.ts:108')
}

export function stopOrDismissAgent(taskId: string, setAppState: SetAppState, reason?: string): void {
  return notBuilt('src/state/crewmateViewHelpers.ts:112')
}

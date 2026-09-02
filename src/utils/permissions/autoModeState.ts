
export interface AutoModeState {
  active: boolean
  flagCli: boolean
  circuitBroken: boolean
}

export function createAutoModeState(): AutoModeState {
  return {
    active: false,
    flagCli: false,
    circuitBroken: false,
  }
}

let globalAutoModeState: AutoModeState = createAutoModeState()

export function setAutoModeActive(active: boolean): void {
  globalAutoModeState.active = active
}

export function isAutoModeActive(): boolean {
  return globalAutoModeState.active
}

export function setAutoModeFlagCli(passed: boolean): void {
  globalAutoModeState.flagCli = passed
}

export function getAutoModeFlagCli(): boolean {
  return globalAutoModeState.flagCli
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  globalAutoModeState.circuitBroken = broken
}

export function isAutoModeCircuitBroken(): boolean {
  return globalAutoModeState.circuitBroken
}

export function _setGlobalAutoModeStateForTesting(state: AutoModeState): void {
  globalAutoModeState = state
}

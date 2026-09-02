// Auto-mode state accessors, isolated here so a caller can pull them in via
// conditional require() behind feature('TRANSCRIPT_CLASSIFIER').
//
// The booleans live on a single mutable AutoModeState record built by
// createAutoModeState(); the module owns one live instance and the accessors
// read/write that record. Tests swap the whole record via
// _setGlobalAutoModeStateForTesting() rather than resetting fields in place.

/**
 * The complete auto-mode session state. A single mutable instance is held by
 * this module (`globalAutoModeState`); all accessors read/write that instance.
 */
export interface AutoModeState {
  /** True while the session is actively running in auto mode. */
  active: boolean
  /** True when auto mode was requested via the CLI flag at startup. */
  flagCli: boolean
  /**
   * True after the auto-mode gate was tripped (e.g. the async
   * verifyAutoModeGateAccess check read a fresh
   * mercury_auto_mode_config.enabled === 'disabled' from the gate table). Used by
   * isAutoModeGateEnabled() to block SDK/explicit re-entry after kick-out.
   *
   * NOTE (fork): this flag is only ever SET by verifyAutoModeGateAccess, which
   * Mercury never runs (it's TRANSCRIPT_CLASSIFIER-gated). Mercury
   * therefore honors the 'disabled' kill-switch by reading the cached
   * config directly inside isAutoModeGateEnabled() — this flag stays false there.
   */
  circuitBroken: boolean
}

/** Build a fresh, all-false AutoModeState record. */
export function createAutoModeState(): AutoModeState {
  return {
    active: false,
    flagCli: false,
    circuitBroken: false,
  }
}

// The single live module-owned instance.
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

/**
 * Testing seam: swap the whole live record so tests can install an arbitrary
 * starting state (typically a fresh createAutoModeState()). Replaces the old
 * _resetForTesting() field-zeroing.
 */
export function _setGlobalAutoModeStateForTesting(state: AutoModeState): void {
  globalAutoModeState = state
}

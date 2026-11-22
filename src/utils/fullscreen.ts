import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

import { getIsInteractive } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'
import { notBuilt } from '../pi/holes.js'


export function isFullscreenEnvEnabled(): boolean {
  return notBuilt('src/utils/fullscreen.ts:47')
}

export function isFullscreenActive(): boolean {
  return notBuilt('src/utils/fullscreen.ts:61')
}

export function isMouseTrackingEnabled(): boolean {
  return notBuilt('src/utils/fullscreen.ts:65')
}

export function isMouseClicksDisabled(): boolean {
  return notBuilt('src/utils/fullscreen.ts:69')
}

export async function maybeGetTmuxMouseHint(): Promise<string | null> {
  return notBuilt('src/utils/fullscreen.ts:75')
}


export function isDeckPaneEnabled(): boolean {
  return notBuilt('src/utils/fullscreen.ts:88')
}

export function isDeckPaneActive(): boolean {
  return notBuilt('src/utils/fullscreen.ts:92')
}

export function isHelmHomeEnabled(): boolean {
  return notBuilt('src/utils/fullscreen.ts:96')
}

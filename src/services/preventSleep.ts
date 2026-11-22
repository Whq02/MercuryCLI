import { spawn, type ChildProcess } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'

import { registerCleanup } from '../utils/cleanupRegistry.js'
import { passedOver } from '../utils/passedOver.js'
import { startInterval, stopInterval } from '../utils/timers.js'
import { notBuilt, unbuilt } from '../pi/holes.js'
let helper: ChildProcess | null = unbuilt('src/services/preventSleep.ts:13')
let restartTimer: NodeJS.Timeout | null = unbuilt('src/services/preventSleep.ts:14')

function killHelper(): void {
  if (helper === null) return
  try {
    helper.kill('SIGKILL')
  } catch (error) {
    passedOver(error)
  }
  helper = null
}

function disarmRestartTimer(): void {
  if (restartTimer !== null) {
    stopInterval(restartTimer)
    restartTimer = null
  }
}

export function startPreventSleep(): void {
  return notBuilt('src/services/preventSleep.ts:75')
}

export function stopPreventSleep(): void {
  return notBuilt('src/services/preventSleep.ts:83')
}

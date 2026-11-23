import { spawn, type ChildProcess } from 'node:child_process'
import { subprocessEnv } from '../processes/subprocessEnv.js'

import { registerCleanup } from '../processes/cleanupRegistry.js'
import { passedOver } from '../errors/passedOver.js'
import { startInterval, stopInterval } from '../async/timers.js'

let referenceCount = 0
let cleanupRegistered = false
let helper: ChildProcess | null = null
let restartTimer: NodeJS.Timeout | null = null

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

function startHelper(): void {
  if (process.platform !== 'darwin' || helper !== null) return
  try {
    if (!cleanupRegistered) {
      registerCleanup(async () => {
        referenceCount = 0
        disarmRestartTimer()
        killHelper()
      })
      cleanupRegistered = true
    }
    const child = spawn('caffeinate', ['-i', '-t', '300'], {
      windowsHide: true, stdio: 'ignore', detached: false, env: { ...subprocessEnv() },
    })
    child.unref()
    const ended = () => { if (helper === child) helper = null }
    child.on('error', ended)
    child.on('exit', ended)
    helper = child
  } catch (error) {
    passedOver(error)
  }
}

function armRestartTimer(): void {
  if (process.platform !== 'darwin' || restartTimer !== null) return
  restartTimer = startInterval(() => {
    if (referenceCount > 0) {
      killHelper()
      startHelper()
    }
  }, 240_000)
  restartTimer.unref()
}

export function startPreventSleep(): void {
  referenceCount++
  if (referenceCount === 1) {
    startHelper()
    armRestartTimer()
  }
}

export function stopPreventSleep(): void {
  referenceCount = Math.max(0, referenceCount - 1)
  if (!referenceCount) {
    disarmRestartTimer()
    killHelper()
  }
}

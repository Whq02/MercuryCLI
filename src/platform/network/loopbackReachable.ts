import * as net from 'node:net'
import { startTimeout, stopTimeout } from '../async/timers.js'

export function probeLoopbackPortReachable(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const timer = startTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      stopTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      stopTimeout(timer)
      resolve(false)
    })
  })
}

import { statSync, watch, mkdirSync, type FSWatcher } from 'node:fs'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { passedOver } from '../../utils/passedOver.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../../utils/timers.js'

export const HEARTBEAT_MS = 400

export function projectionChangeKey(stat: { mtimeMs: number; size: number; ino: number }): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
}
export const PROJECTION_ABSENT = 'absent'

export class ProjectionFeed {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private timerMs = 0
  private lastKey = PROJECTION_ABSENT
  private settleUntilMs = 0
  private recheck: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly dir: string,
    private readonly path: string,
    private readonly onChange: () => void,
    private readonly idleFloorMs: () => number = () => HEARTBEAT_MS,
  ) {}
  private readonly tick = (): boolean => {
    let key = PROJECTION_ABSENT
    try {
      key = projectionChangeKey(statSync(this.path))
    } catch {
      key = PROJECTION_ABSENT
    }
    if (key === this.lastKey) return false
    this.lastKey = key
    this.onChange()
    return true
  }
  private readonly report = (): void => {
    if (!this.tick()) this.recheckSoon()
  }
  recheckSoon(): void {
    if (this.recheck !== null) return
    const recheck = startTimeout(() => {
      this.recheck = null
      this.tick()
    }, HEARTBEAT_MS)
    recheck.unref?.()
    this.recheck = recheck
  }
  private cadenceMs(): number {
    if (this.watcher === null) return HEARTBEAT_MS
    if (this.settleUntilMs > Date.now()) return HEARTBEAT_MS
    return this.idleFloorMs()
  }
  rearm(): void {
    if (this.timer === null) return
    const ms = this.cadenceMs()
    if (ms === this.timerMs) return
    stopInterval(this.timer)
    this.timer = startInterval(this.tick, ms)
    this.timer.unref?.()
    this.timerMs = ms
  }
  settle(windowMs: number): void {
    if (windowMs <= 0) return
    this.settleUntilMs = Math.max(this.settleUntilMs, Date.now() + windowMs)
    this.rearm()
    const revert = startTimeout(() => this.rearm(), windowMs)
    revert.unref?.()
  }
  heartbeatMs(): number {
    return this.timer === null ? 0 : this.timerMs
  }
  start(): void {
    if (this.timer !== null) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const watcher = watch(resolveWatchRoot(this.dir), this.report)
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch (error) {
          passedOver(error)
        }
        if (this.watcher === watcher) this.watcher = null
        this.rearm()
      })
      this.watcher = watcher
    } catch (error) {
      passedOver(error)
    }
    this.timerMs = this.cadenceMs()
    this.timer = startInterval(this.tick, this.timerMs)
    this.timer.unref?.()
    this.tick()
  }
  stop(): void {
    if (this.timer !== null) {
      stopInterval(this.timer)
      this.timer = null
      this.timerMs = 0
    }
    if (this.recheck !== null) {
      stopTimeout(this.recheck)
      this.recheck = null
    }
    try {
      this.watcher?.close()
    } catch (error) {
      passedOver(error)
    }
    this.watcher = null
    this.lastKey = PROJECTION_ABSENT
    this.settleUntilMs = 0
  }
}

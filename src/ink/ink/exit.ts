import instances from '../instances.js'
import { optimizePatches } from '../patch-stream.js'
import reconciler from '../reconciler.js'
import { runTeardownSuite } from '../root/teardown.js'
import { writeDiffToTerminal } from '../session/delivery.js'
import { drainStdin } from './stdin.js'
import type Ink from '../ink.js'
import type { ExitOutcome } from './record.js'

type UnmountReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'frontFrame' | 'rootNode' | 'container' | 'writer' | 'scheduler' | 'isUnmounted' | 'restoreConsole' | 'removeTtySubscriptions'
  | 'exitOutcomeLatch' | 'exitOutcome' | 'unsubscribeExit' | 'resolveExitPromise' | 'rejectExitPromise' | 'clearResizeSettle' | 'onRender'
  | 'teardownHost'
>

export function unmount(this: UnmountReads, error?: Error | number | null): void {
  if (this.isUnmounted) return
  this.onRender()
  this.unsubscribeExit()
  if (this.restoreConsole) {
    this.restoreConsole()
    this.restoreConsole = null
  }
  this.removeTtySubscriptions?.()
  this.removeTtySubscriptions = null

  const finish = optimizePatches(this.writer.finish(this.frontFrame))
  writeDiffToTerminal(
    { stdout: this.options.stdout, stderr: this.options.stderr },
    finish,
    true,
  )

  if (this.isTTY) {
    runTeardownSuite(this.teardownHost())
  }

  this.isUnmounted = true
  this.clearResizeSettle()
  this.scheduler.cancel()
  reconciler.updateContainerSync(null, this.container, null, null)
  reconciler.flushSyncWork()
  if (instances.get(this.options.stdout) === this) instances.delete(this.options.stdout)
  const layout = this.rootNode.layoutNode
  if (layout) {
    layout.free()
    this.rootNode.layoutNode = undefined
  }

  const outcome: ExitOutcome =
    error instanceof Error ? { kind: 'error', error } : { kind: 'ok' }
  this.exitOutcome = outcome
  this.exitOutcomeLatch = outcome
  if (outcome.kind === 'error') this.rejectExitPromise(outcome.error)
  else this.resolveExitPromise()
}

export function waitUntilExit(this: Pick<Ink, 'options' | 'exitPromise' | 'exitOutcomeLatch' | 'resolveExitPromise' | 'rejectExitPromise'>): Promise<void> {
  if (this.options.waitUntilExit) return this.options.waitUntilExit()
  if (this.exitPromise) return this.exitPromise
  const latch = this.exitOutcomeLatch
  if (latch) {
    return latch.kind === 'error' ? Promise.reject(latch.error) : Promise.resolve()
  }
  this.exitPromise = new Promise<void>((resolve, reject) => {
    this.resolveExitPromise = resolve
    this.rejectExitPromise = reject
  })
  return this.exitPromise
}

export function detachForShutdown(this: Pick<Ink, 'options' | 'scheduler' | 'isUnmounted' | 'clearResizeSettle'>): void {
  this.isUnmounted = true
  this.clearResizeSettle()
  this.scheduler.cancel()
  drainStdin(this.options.stdin)
  const { stdin } = this.options
  if (stdin.isTTY && stdin.isRaw) {
    try {
      stdin.setRawMode(false)
    } catch {
    }
  }
}

import { logForDebugging } from '../utils/debug.js'


let inputLive = false
let resolveInputLive: () => void = () => {}
const inputLivePromise = new Promise<void>(resolve => {
  resolveInputLive = resolve
})

export function signalInputLive(): void {
  if (inputLive) return
  inputLive = true
  resolveInputLive()
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordLaunchMilestone } = require('../substrate/launchMilestones.js') as typeof import('../substrate/launchMilestones.js')
    recordLaunchMilestone('input-live')
  } catch {
  }
}

export function isInputLive(): boolean {
  return inputLive
}


interface BackgroundNode {
  id: string
  run: () => void | Promise<void>
}

const backgroundNodes: BackgroundNode[] = []
let backgroundStarted = false
let backgroundArmed = false

const BACKGROUND_SETTLE_MS = 250
const BACKGROUND_DEADLINE_MS = 3_000
const BACKGROUND_LANE_WIDTH = 3

export function registerBackgroundNode(id: string, run: () => void | Promise<void>): void {
  if (backgroundStarted) {
    void runNode({ id, run })
    return
  }
  backgroundNodes.push({ id, run })
}

async function runNode(node: BackgroundNode): Promise<void> {
  try {
    await node.run()
  } catch (e) {
    logForDebugging(`[launch-graph] background node ${node.id} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function armBackgroundDiscovery(): void {
  if (backgroundArmed) return
  backgroundArmed = true
  void (async () => {
    await Promise.race([
      inputLivePromise,
      new Promise<void>(resolve => setTimeout(resolve, BACKGROUND_DEADLINE_MS)),
    ])
    await new Promise<void>(resolve => setTimeout(resolve, BACKGROUND_SETTLE_MS))
    backgroundStarted = true
    const inFlight = new Set<Promise<void>>()
    while (backgroundNodes.length > 0) {
      while (inFlight.size >= BACKGROUND_LANE_WIDTH) {
        await Promise.race(inFlight)
      }
      const node = backgroundNodes.shift()!
      const run = runNode(node)
      const tracked: Promise<void> = run.finally(() => {
        inFlight.delete(tracked)
      })
      inFlight.add(tracked)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  })()
}

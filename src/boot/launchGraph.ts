// ============================================================================
//  src/boot/launchGraph.ts — the explicit launch
//  graph. The ONE owner of interactive startup CLASSIFICATION.
//
//  Every piece of interactive startup work belongs to exactly one class:
//
//  · required-before-render — completes before the cockpit paints. Owned by
//    the pre-render sequence in main.tsx (permission context → setup() →
//    commands/agents → trust) and by replLauncher.launchRepl (boot-recovery
//    race → paint-surface import → render). Nothing joins this class without
//    flipping a boot-contract law (scripts/core-runtime/prove-boot-contract.ts).
//
//  · before-editable — the render→input-live window. This class is kept
//    EMPTY by construction: the T5 session owner arms raw input, and no
//    startup work may be scheduled between render and that arm. The
//    input-live signal below exists so background work provably waits it out.
//
//  · before-first-submission — kicked before render for subprocess overlap,
//    consumed by the turn pipeline, never gates paint or input. Today:
//    SessionStart hooks (pendingHookMessages — the REPL awaits them before
//    the first API call) and the permission/tool context.
//
//  · background-discovery — optional integrations and status discovery:
//    quota/bootstrap/passes network warms, the extensions load,
//    LSP manager, session registry, example commands, deferred cache warms,
//    MINERVA. These merge through existing stores after the operator can
//    already type. They are REGISTERED during the pre-render sequence and
//    START only after the cockpit is input-live (or at a hard deadline so
//    they always run). MCP servers are NOT a node: the REPL's connection
//    registry (useManageMCPConnections) discovers and connects them after
//    its mount — one owner, so no server is spawned twice.
//
//  Print mode (-p / SDK) never touches this module — the headless path keeps
//  its own inline sequencing in main.tsx/print.ts (T11's surface).
// ============================================================================
import { logForDebugging } from '../utils/debug.js'

// ── input-live signal (the editable milestone) ──────────────────────────────
// Fired by the owned Ink runtime at the FIRST raw-mode arm — the exact
// statement where the app's own readable handler takes stdin (see
// src/ink/components/App.tsx handleSetRawMode). From that moment keystrokes
// are the app's, so background work no longer competes with getting there.

let inputLive = false
let resolveInputLive: () => void = () => {}
const inputLivePromise = new Promise<void>(resolve => {
  resolveInputLive = resolve
})

export function signalInputLive(): void {
  if (inputLive) return
  inputLive = true
  resolveInputLive()
  // The input-live milestone — the launch spine's last rung.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordLaunchMilestone } = require('../substrate/launchMilestones.js') as typeof import('../substrate/launchMilestones.js')
    recordLaunchMilestone('input-live')
  } catch {
    /* telemetry only */
  }
}

export function isInputLive(): boolean {
  return inputLive
}

// ── background-discovery scheduling ─────────────────────────────────────────

interface BackgroundNode {
  id: string
  run: () => void | Promise<void>
}

const backgroundNodes: BackgroundNode[] = []
let backgroundStarted = false
let backgroundArmed = false

/** How long after input-live the background class waits before starting —
 *  keeps the first paint + arm frames free of freshly-spawned subprocesses. */
const BACKGROUND_SETTLE_MS = 250
/** Hard ceiling from arm → start, so background discovery always runs even
 *  if the input-live signal never fires (e.g. a dialog-less error path). */
const BACKGROUND_DEADLINE_MS = 3_000
/** How many background nodes may be IN FLIGHT at once. Nodes are
 *  independent discovery lanes (MCP config, session registry, extensions,
 *  MINERVA…), so a genuinely-async node must not head-of-line block the
 *  ones registered after it; the bound keeps the post-paint window from
 *  absorbing every spawn at once. */
const BACKGROUND_LANE_WIDTH = 3

/**
 * Register a background-discovery node. Register during the pre-render
 * sequence; nodes run in registration order once the graph starts them.
 * A node registered after the class already started runs immediately —
 * late registration never silently drops work.
 */
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
    // Background discovery is best-effort by definition — a failing node
    // must never take the session down. Nodes own their user-visible
    // error surfacing (stores/notifications); this is the last net.
    logForDebugging(`[launch-graph] background node ${node.id} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Arm the background-discovery class. Called ONCE per interactive boot at
 * the point where trust is established (after showSetupScreens) — nothing
 * armed here can execute
 * before that boundary (MCP prefetch stays behind the trust
 * boundary). Start = input-live + settle, bounded by the deadline.
 */
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
    // Drain KICKS in registration order with one event-loop turn between
    // them (staggering each node's synchronous spawn cost), but node RUNS
    // overlap up to the lane width: some nodes genuinely await their own
    // I/O (mcp-discovery awaits its config resolve; MINERVA its boot pass),
    // and the old `await runNode` drain head-of-line blocked every node
    // registered after them — serializing exactly the I/O its comment
    // claimed it never touched. Independent lanes now proceed while a slow
    // one is still in flight; start order stays the registration order.
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
      // One full turn between kicks — the synchronous prefix of each node
      // gets the loop to itself before the next node starts.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  })()
}

// ============================================================================
//  cli/agentFreshness — THE SEAMLESS LAW's engine half.
//
//  Every live session is a daemon-hosted stream-json runner of this module's
//  host (cli/print.ts) — and until this seam its agent roster was a boot
//  snapshot: the ONLY subscriber of the agents watch was the cockpit REPL
//  (hooks/useAgentsChange), so an agent created mid-session — the Boot
//  face's create, /agents in another terminal, a plain editor write —
//  never reached a running session's Agent tool. The operator's whole ask
//  is the round-trip: menu → create → back → THE SESSION SEES IT.
//
//  This arms the SAME per-process watch owner (services/agents/watch.ts —
//  chokidar over every discovery root, debounced+coalesced, self-write
//  suppressed) in the RUNNER. The store's self-write ring lives with the
//  WRITER's process, so a face/cockpit save is honestly FOREIGN here and
//  notifies; the handler re-reads through the invalidated loader and swaps
//  the host's roster, preserving what only the session knows (`--agents`
//  flag definitions — source 'flagSettings', never file-backed: the
//  refreshExtensionState law). The NEXT turn's context carries the fresh
//  roster (the host rebuilds its context per turn); an in-flight turn
//  keeps its spawn-pinned snapshot — the landed in-flight law
//  (hooks/useAgentsChange's docblock).
//
//  Lazy imports on purpose: chokidar and the loader join the graph at ARM
//  time, off the boot path (the useAgentsChange arm-delay precedent — no
//  paint here, but the boot handshake stays uncontended). The runner keeps
//  its ground for life (sessions never re-ground mid-flight — the
//  seam call), so the cwd read at arm time stands; the reload
//  still reads it fresh, and startAgentWatch restarts on a cwd change by
//  its own idempotence law if a future road ever moves a runner's ground.
// ============================================================================
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { logForDebugging } from '../utils/debug.js'

/** The boot-settle arm delay (the useAgentsChange precedent's value). */
export const RUNNER_AGENT_WATCH_ARM_DELAY_MS = 1500

/**
 * Arm the runner's agent-definition freshness road. Returns the disarm:
 * timer cleared, subscription dropped, the process watcher closed.
 */
export function armRunnerAgentFreshness(args: {
  cwd: () => string
  getActive: () => AgentDefinition[]
  setActive: (next: AgentDefinition[]) => void
  /** Test seam: the arm delay (default the boot-settle 1500ms). */
  armDelayMs?: number
}): () => void {
  let disposed = false
  let unsubscribe: (() => void) | null = null
  const arm = setTimeout(() => {
    void (async () => {
      try {
        const watch = await import('../services/agents/watch.js')
        if (disposed) return
        unsubscribe = watch.subscribeAgentsChanged(() => {
          void (async () => {
            try {
              const { getAgentDefinitionsWithOverrides } = await import(
                '../tools/AgentTool/loadAgentsDir.js'
              )
              const fresh = await getAgentDefinitionsWithOverrides(args.cwd())
              if (disposed) return
              const sdkInjected = args.getActive().filter(a => a.source === 'flagSettings')
              args.setActive([...fresh.activeAgents, ...sdkInjected])
              logForDebugging(
                `runner agent roster refreshed: ${fresh.activeAgents.length} active from disk`,
              )
            } catch (error) {
              logForDebugging(`runner agent refresh failed: ${String(error)}`)
            }
          })()
        })
        await watch.startAgentWatch(args.cwd())
      } catch (error) {
        logForDebugging(`runner agent watch failed to arm: ${String(error)}`)
      }
    })()
  }, args.armDelayMs ?? RUNNER_AGENT_WATCH_ARM_DELAY_MS)
  arm.unref?.()
  return () => {
    disposed = true
    clearTimeout(arm)
    unsubscribe?.()
    unsubscribe = null
    void import('../services/agents/watch.js')
      .then(watch => watch.stopAgentWatch())
      .catch(() => {})
  }
}

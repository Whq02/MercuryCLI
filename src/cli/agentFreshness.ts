import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { logForDebugging } from '../utils/debug.js'

export const RUNNER_AGENT_WATCH_ARM_DELAY_MS = 1500

export function armRunnerAgentFreshness(args: {
  cwd: () => string
  getActive: () => AgentDefinition[]
  setActive: (next: AgentDefinition[]) => void
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

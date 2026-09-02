/**
 * The production McpRegistryPorts — binds the owned registry
 * (serverRegistry.ts) to the live client machinery (core-ownership Phase 4).
 *
 * Kept in its own module so serverRegistry.ts stays dependency-light and
 * hermetically testable: importing the registry never pulls the SDK/client
 * stack; only this module does.
 *
 *   • connect        → reconnectMcpServerImpl (keychain-cache invalidation +
 *                      server-cache clear + connect + capability fetches)
 *   • connectMany    → getMcpToolsCommandsAndResources (the initial batch
 *                      path: split local/remote concurrency, cross-server
 *                      resource-tool dedup, per-settle callback)
 *   • disconnect     → clearServerCache
 *   • disk store     → isMcpCatalogueMember (the membership-predicate
 *                      owner, membership.ts) / the PROCESS KIT's edit road
 *                      (ledger L24(3)): a screen-estate toggle
 *                      (the /mcp panel's rows) is THIS process's own dial —
 *                      it edits the process kit (materialize-then-edit over
 *                      the standing off-record) and never the shared
 *                      project config the old setMcpServerEnabled binding
 *                      wrote (the exact isolation violation: a session-
 *                      scope dial editing what sibling sessions read). The
 *                      registry's isDisabledOnDisk consult answers the new
 *                      truth at once — the owner reads the latch.
 *   • sleep          → abortable setTimeout (the backoff clock)
 */
import { getCurrentProjectConfig } from '../../../utils/config.js'
import { disabledMcpServerNamesIn } from '../disabledRecord.js'
import { applyProcessSessionKitEdit } from '../sessionKitPin.js'
import { isMcpCatalogueMember } from '../membership.js'
import {
  clearServerCache,
  getMcpToolsCommandsAndResources,
  reconnectMcpServerImpl,
} from '../client.js'
import type { McpRegistryPorts } from './serverRegistry.js'

export function liveMcpRegistryPorts(): McpRegistryPorts {
  return {
    connect: (name, config) => reconnectMcpServerImpl(name, config),
    connectMany: (configs, onSettle) =>
      getMcpToolsCommandsAndResources(onSettle, configs),
    disconnect: (name, config) => clearServerCache(name, config),
    isDisabledOnDisk: name => !isMcpCatalogueMember(name),
    setEnabledOnDisk: (name, enabled) => {
      applyProcessSessionKitEdit(
        { mcp: [{ name, on: enabled }] },
        disabledMcpServerNamesIn(getCurrentProjectConfig()),
      )
    },
    sleep: (ms, signal) =>
      new Promise<void>(resolve => {
        if (signal.aborted) {
          resolve()
          return
        }
        // eslint-disable-next-line no-restricted-syntax -- the registry owns cancellation via the abort signal
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      }),
  }
}

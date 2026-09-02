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

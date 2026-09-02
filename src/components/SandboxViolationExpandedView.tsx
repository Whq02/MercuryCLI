// The sandbox violation tail: total blocked-operation count, the last 10
// violations with local h:mm:ssa times, and how many of the total are shown.
// Nothing renders when sandboxing is disabled, on Linux, or with zero
// violations.

import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'
import { plural } from '../utils/stringUtils.js'

const SHOWN_LIMIT = 10

function formatViolationTime(at: Date): string {
  let hours = at.getHours()
  const suffix = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12
  if (hours === 0) hours = 12
  return `${hours}:${String(at.getMinutes()).padStart(2, '0')}:${String(
    at.getSeconds(),
  ).padStart(2, '0')}${suffix}`
}

export function SandboxViolationExpandedView(): React.ReactNode {
  const enabled =
    process.platform !== 'linux' && SandboxManager.isSandboxingEnabled()
  const store = enabled ? SandboxManager.getSandboxViolationStore() : null
  const total = useSyncExternalStore(
    listener => (store ? store.subscribe(listener) : () => {}),
    () => (store ? store.getTotalCount() : 0),
  )
  if (!enabled || !store || total === 0) return null

  const shown = store.getViolations(SHOWN_LIMIT)
  return (
    <Box flexDirection="column">
      <Text bold>
        {total} blocked {plural(total, 'operation')}
      </Text>
      {shown.map((violation, index) => (
        <Box key={index} flexDirection="column">
          <Text>
            <Text dimColor>{formatViolationTime(violation.timestamp)} </Text>
            {violation.command ? <Text bold>{violation.command}</Text> : null}
          </Text>
          <Box paddingLeft={2}>
            <Text dimColor wrap="wrap">
              {violation.line}
            </Text>
          </Box>
        </Box>
      ))}
      <Text dimColor>
        showing {Math.min(shown.length, SHOWN_LIMIT)} of {total}
      </Text>
    </Box>
  )
}

export default SandboxViolationExpandedView

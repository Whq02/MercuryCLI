// Read-only report of the effective sandbox configuration: each
// block renders only when its list is non-empty; dependency warnings — read
// by this tab itself — are appended in every state; disabled sandboxing
// reduces the tab to one line plus those warnings.

import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  SandboxManager,
  shouldAllowManagedSandboxDomainsOnly,
} from '../../utils/sandbox/sandbox-adapter.js'
import { getPlatform } from '../../utils/platform.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

/** Unsupported-glob warnings list at most this many patterns. */
const GLOB_WARNING_CAP = 3

function ListBlock({
  title,
  items,
  nested,
  nestedTitle,
}: {
  title: string
  items: string[]
  nested?: string[]
  nestedTitle?: string
}): React.ReactNode {
  if (items.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {items.map((item, index) => (
        <Text key={index} dimColor>
          {'  '}
          {item}
        </Text>
      ))}
      {nested !== undefined && nested.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>{nestedTitle}</Text>
          {nested.map((item, index) => (
            <Text key={index} dimColor>
              {'  '}
              {item}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

export function SandboxConfigTab(): React.ReactNode {
  const tokens = useMercuryTokens()
  // Dependency warnings are read by this tab itself, appended in ALL states.
  const warnings = SandboxManager.checkDependencies().warnings

  if (!SandboxManager.isSandboxingEnabled()) {
    return (
      <Box flexDirection="column">
        <Text color={tokens.textSecondary}>Sandboxing is disabled.</Text>
        {warnings.map((warning, index) => (
          <Text key={index} color={tokens.warning}>
            {warning}
          </Text>
        ))}
      </Box>
    )
  }

  const excluded = SandboxManager.getExcludedCommands()
  const fsRead = SandboxManager.getFsReadConfig()
  const fsWrite = SandboxManager.getFsWriteConfig()
  const network = SandboxManager.getNetworkRestrictionConfig()
  const unixSockets = SandboxManager.getAllowUnixSockets() ?? []
  const globWarnings = SandboxManager.getLinuxGlobPatternWarnings()
  const managedOnly = shouldAllowManagedSandboxDomainsOnly()

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Excluded commands</Text>
        {excluded.length === 0 ? (
          <Text dimColor>{'  '}None</Text>
        ) : (
          excluded.map((command, index) => (
            <Text key={index} dimColor>
              {'  '}
              {command}
            </Text>
          ))
        )}
      </Box>
      <ListBlock
        title="Filesystem read denials"
        items={fsRead.denyOnly}
        nested={fsRead.allowWithinDeny}
        nestedTitle="allowed within:"
      />
      <ListBlock
        title="Filesystem write allowances"
        items={fsWrite.allowOnly}
        nested={fsWrite.denyWithinAllow}
        nestedTitle="denied within:"
      />
      <ListBlock
        title={
          managedOnly ? 'Allowed network hosts (managed)' : 'Allowed network hosts'
        }
        items={network.allowedHosts ?? []}
      />
      <ListBlock
        title="Denied network hosts"
        items={network.deniedHosts ?? []}
      />
      <ListBlock title="Allowed unix sockets" items={unixSockets} />
      {globWarnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={tokens.warning}>
            {globWarnings.length}{' '}
            {globWarnings.length === 1 ? 'pattern' : 'patterns'} unsupported on{' '}
            {getPlatform()} and ignored:
          </Text>
          {globWarnings.slice(0, GLOB_WARNING_CAP).map((pattern, index) => (
            <Text key={index} dimColor>
              {'  '}
              {pattern}
            </Text>
          ))}
          {globWarnings.length > GLOB_WARNING_CAP ? (
            <Text dimColor>
              {'  '}+{globWarnings.length - GLOB_WARNING_CAP} more
            </Text>
          ) : null}
        </Box>
      ) : null}
      {warnings.map((warning, index) => (
        <Text key={index} color={tokens.warning}>
          {warning}
        </Text>
      ))}
    </Box>
  )
}

// MCP config parse diagnostics, rendered above the /mcp list — only when at
// least one scope carries a fatal error or a warning. Fatal rows precede
// warning rows within a section; a finding without a recognised severity is
// not shown at all.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { ConfigScope } from '../../services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  getScopeLabel,
} from '../../services/mcp/utils.js'

/** The parse-finding shape (structurally matches the config reader's
 *  unexported error rows). */
export type McpConfigFinding = {
  filePath: string
  path: string
  message: string
  suggestion?: string
  scope: ConfigScope
  serverName?: string
  severity: 'fatal' | 'warning'
}

/** Section order (contract data — the MCP config scopes). */
const SCOPE_ORDER: readonly ConfigScope[] = [
  'user',
  'project',
  'local',
  'enterprise',
]

export function McpParsingWarnings({
  errors,
}: {
  errors: McpConfigFinding[]
}): React.ReactNode {
  const recognised = errors.filter(
    finding => finding.severity === 'fatal' || finding.severity === 'warning',
  )
  if (recognised.length === 0) return null

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="warning">
        MCP configuration diagnostics
      </Text>
      <Text dimColor>See /mcp for help.</Text>
      {SCOPE_ORDER.map(scope => {
        const findings = recognised.filter(finding => finding.scope === scope)
        if (findings.length === 0) return null
        const hasFatal = findings.some(finding => finding.severity === 'fatal')
        const ordered = [
          ...findings.filter(finding => finding.severity === 'fatal'),
          ...findings.filter(finding => finding.severity === 'warning'),
        ]

        return (
          <Box key={scope} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={hasFatal ? 'error' : 'warning'}>
                [{hasFatal ? 'failed to parse' : 'contains warnings'}]
              </Text>{' '}
              {getScopeLabel(scope)}
              <Text dimColor> ({describeMcpConfigFilePath(scope)})</Text>
            </Text>
            {ordered.map((finding, index) => (
              <Text key={index} wrap="wrap">
                <Text dimColor>{'  ╰ '}</Text>
                <Text
                  color={finding.severity === 'fatal' ? 'error' : 'warning'}
                >
                  [{finding.severity === 'fatal' ? 'error' : 'warning'}]
                </Text>
                {finding.serverName ? <Text> [{finding.serverName}]</Text> : null}
                {finding.path !== '' ? (
                  <Text dimColor> {finding.path}</Text>
                ) : null}{' '}
                {finding.message}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

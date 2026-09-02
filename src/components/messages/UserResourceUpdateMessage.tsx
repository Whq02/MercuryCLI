// MCP resource/polling update rows parsed out of the transcript wire tags
// (contract data: mcp-resource-update server/uri · mcp-polling-update
// type/server/tool · nested reason). A file:// URI collapses to its
// filename; any other URI longer than 40 characters is ellipsised.

import React from 'react'
import { Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'

type ResourceUpdate = {
  kind: 'resource'
  server: string
  uri: string
  reason: string | null
}
type PollingUpdate = {
  kind: 'polling'
  type: string
  server: string
  tool: string
  reason: string | null
}

function attribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`))
  return match?.[1] ?? ''
}

function nestedReason(tag: string): string | null {
  const match = tag.match(/<reason>([\s\S]*?)<\/reason>/)
  return match?.[1] ?? null
}

function parseUpdates(text: string): Array<ResourceUpdate | PollingUpdate> {
  const updates: Array<ResourceUpdate | PollingUpdate> = []
  const resourceRe =
    /<mcp-resource-update\b[^>]*(?:\/>|>[\s\S]*?<\/mcp-resource-update>)/g
  const pollingRe =
    /<mcp-polling-update\b[^>]*(?:\/>|>[\s\S]*?<\/mcp-polling-update>)/g
  for (const match of text.match(resourceRe) ?? []) {
    updates.push({
      kind: 'resource',
      server: attribute(match, 'server'),
      uri: attribute(match, 'uri'),
      reason: nestedReason(match),
    })
  }
  for (const match of text.match(pollingRe) ?? []) {
    updates.push({
      kind: 'polling',
      type: attribute(match, 'type'),
      server: attribute(match, 'server'),
      tool: attribute(match, 'tool'),
      reason: nestedReason(match),
    })
  }
  return updates
}

function displayUri(uri: string): string {
  if (uri.startsWith('file://')) {
    const segments = uri.split('/')
    return segments[segments.length - 1] || uri
  }
  if (uri.length > 40) return `${uri.slice(0, 39)}…`
  return uri
}

export function UserResourceUpdateMessage({
  addMargin,
  param,
}: {
  addMargin?: boolean
  param: TextBlockParam
}): React.ReactNode {
  const updates = parseUpdates(param.text)
  if (updates.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      {updates.map((update, index) => (
        <Text key={index} dimColor>
          <Text color="success">↻ </Text>
          {update.server}
          {': '}
          {update.kind === 'resource'
            ? displayUri(update.uri)
            : `${update.type} ${update.tool}`.trim()}
          {update.reason ? <Text dimColor> — {update.reason}</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

export default UserResourceUpdateMessage

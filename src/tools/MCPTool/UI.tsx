import * as React from 'react'

import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { Ansi } from '../../ink/Ansi.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../utils/glyphs.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import type { MCPProgress } from '../../types/tools.js'
import { formatNumber } from '../../utils/format.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { getContentSizeEstimate, type MCPToolResult } from '../../services/mcp/mcpValidation.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'


const LARGE_RESPONSE_TOKEN_THRESHOLD = 10_000

const PROGRESS_BAR_WIDTH = 20


export function renderToolUseMessage(
  input: Record<string, unknown> | undefined,
  _options: { verbose: boolean },
): React.ReactNode {
  const entries = Object.entries(input ?? {})
  if (entries.length === 0) return ''
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
}


export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<MCPProgress>[],
): React.ReactNode {
  return notBuilt('src/tools/MCPTool/UI.tsx:32')
}


const MESSAGE_LINK_TOKEN = '"message_link"'

const SLACK_PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p\d+$/

const SLACK_PAYLOAD_MAX_KEYS = 6
const SLACK_PAYLOAD_MAX_CHARS = 2_000

function candidateText(output: MCPToolResult): string | undefined {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return undefined
  const firstText = output.find(block => block.type === 'text') as { text?: unknown } | undefined
  return typeof firstText?.text === 'string' ? firstText.text : undefined
}

function tryCraftStatusCompact(output: MCPToolResult): string | null {
  if (Array.isArray(output) && output.length !== 1) return null
  const raw = candidateText(output)
  if (raw === undefined) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) { passedOver(error); return null }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const status = value as Record<string, unknown>
  if (!['FilmCraft', 'PhotoCraft', 'LightCraft'].includes(String(status.app)) ||
      typeof status.version !== 'string' || typeof status.destination !== 'string' ||
      typeof status.bytes !== 'number' || !Number.isFinite(status.bytes) ||
      Object.keys(status).some(key => !['app', 'version', 'state', 'destination', 'bytes', 'attached', 'reason'].includes(key))) return null
  const name = `${status.app} ${status.version}`
  if (status.state === 'invalid') return typeof status.reason === 'string' ? `${name} — installation invalid. ${status.reason}` : null
  if (status.reason !== undefined) return null
  if (status.state === 'absent' && status.attached === undefined) return `${name} is not installed. Use craft_install.`
  if (status.state !== 'installed') return null
  if (status.attached === undefined) return `${name} is installed. Use craft_connect to attach or launch.`
  if (status.attached === null || typeof status.attached !== 'object' || Array.isArray(status.attached)) return null
  const attached = status.attached as Record<string, unknown>
  if (typeof attached.project !== 'string') return null
  return `${name} — ${attached.headless === true ? 'headless session' : 'attached'}: ${attached.project}`
}


function ImagePlaceholder(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Box width="100%">
        <Text>[Image]</Text>
      </Box>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: MCPToolResult,
  _progressMessages: unknown,
  arg2: { verbose: boolean; input?: unknown },
): React.ReactNode {
  return notBuilt('src/tools/MCPTool/UI.tsx:181')
}

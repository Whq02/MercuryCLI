import { relative } from 'node:path'

import React from 'react'

import { flagEnv } from '../../substrate/flagRegistry.js'
import { GLYPH } from '../../utils/glyphs.js'
import { Box, Text } from '../../ink.js'
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from '../../services/instructions/engine.js'
import type { InstructionSourceEntry } from '../../utils/instructions/contracts.js'
import type { AgentDefinitionsResult } from '../../types/agent.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getSubscriptionName,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import type { GlobalConfig } from '../../utils/config/schema.js'
import { binaryName } from '../../utils/config/derived.js'
import { getCwd } from '../../utils/cwd.js'
import { formatNumber } from '../../utils/format.js'
import { AGENT_DESCRIPTIONS_THRESHOLD, getAgentDescriptionsTotalTokens } from './statusNoticeHelpers.js'
import { readPinnedStatus } from '../../mneme/mnemeFrontPage.js'
import { mnemeEnabled } from '../../mneme/mnemeGates.js'
import { formatTextSize } from '../../mneme/mnemeUsage.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type StatusNoticeType = 'warning' | 'info'

type StatusNoticeContext = Unbuilt

type StatusNoticeDefinition = Unbuilt

function shortenMemoryPath(filePath: string): string {
  const cwd = getCwd()
  return filePath.startsWith(cwd) ? relative(cwd, filePath) : filePath
}

function describeTokenSource(source: string): string {
  return source === 'claude.ai' ? `your ${getSubscriptionName()} login` : source
}

const largeMemoryFilesNotice: StatusNoticeDefinition = unbuilt('src/components/statusNotices/statusNoticeDefinitions.tsx:53')

const largeAgentDescriptionsNotice: StatusNoticeDefinition = unbuilt('src/components/statusNotices/statusNoticeDefinitions.tsx:70')

const claudeAiExternalTokenNotice: StatusNoticeDefinition = {
  id: 'claude-ai-external-token',
  type: 'warning',
  isActive: (context: StatusNoticeContext) => {
    void context
    if (!isClaudeAISubscriber()) return false
    const tokenSource = getAuthTokenSource().source
    return tokenSource === 'ANTHROPIC_AUTH_TOKEN' || tokenSource === 'credentials.keyCommand'
  },
  render: (context: StatusNoticeContext) => {
    void context
    const tokenSource = getAuthTokenSource().source
    return (
      <Box marginTop={1}>
        <Text color="warning">
          {GLYPH.warn} {tokenSource} is being used instead of your {getSubscriptionName()} subscription token.
          Unset it, or run `{binaryName()} /logout` and sign in again.
        </Text>
      </Box>
    )
  },
}

const apiKeyConflictNotice: StatusNoticeDefinition = unbuilt('src/components/statusNotices/statusNoticeDefinitions.tsx:107')

const bothAuthMethodsNotice: StatusNoticeDefinition = unbuilt('src/components/statusNotices/statusNoticeDefinitions.tsx:136')

type PinnedOverLimit = { pinned: number; used: number; limit: number } | null

let pinnedOverLimitAtStart: PinnedOverLimit | undefined

function pinnedOverLimit(): PinnedOverLimit {
  if (pinnedOverLimitAtStart !== undefined) return pinnedOverLimitAtStart
  let read: PinnedOverLimit = null
  try {
    if (mnemeEnabled() && flagEnv('MERCURY_ENTRYPOINT') !== 'headless') {
      const status = readPinnedStatus()
      read = status && status.over ? { pinned: status.pinned, used: status.used, limit: status.limit } : null
    }
  } catch {
    read = null
  }
  pinnedOverLimitAtStart = read
  return read
}

export function pinnedOverLimitLine(status: { pinned: number; used: number; limit: number }): string {
  return `Pinned memory: ${status.pinned} rule${status.pinned === 1 ? '' : 's'}, ${formatTextSize(status.used)} of the ${formatTextSize(status.limit)} limit — all still loaded. Trim in /memory or raise the limit in /config.`
}

const pinnedOverLimitNotice: StatusNoticeDefinition = {
  id: 'pinned-over-limit',
  type: 'info',
  isActive: (context: StatusNoticeContext) => {
    void context
    return pinnedOverLimit() !== null
  },
  render: (context: StatusNoticeContext) => {
    void context
    const status = pinnedOverLimit()
    if (!status) return null
    return (
      <Text dimColor>
        {GLYPH.info} {pinnedOverLimitLine(status)}
      </Text>
    )
  },
}

const statusNoticeDefinitions: StatusNoticeDefinition[] = [
  largeMemoryFilesNotice,
  largeAgentDescriptionsNotice,
  pinnedOverLimitNotice,
  claudeAiExternalTokenNotice,
  apiKeyConflictNotice,
  bothAuthMethodsNotice,
]

export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return notBuilt('src/components/statusNotices/statusNoticeDefinitions.tsx:231')
}

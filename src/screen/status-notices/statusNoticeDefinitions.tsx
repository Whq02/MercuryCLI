import { relative } from 'node:path'

import React from 'react'

import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { GLYPH } from '../theme/glyphs.js'
import { Box, Text } from '../themedRenderer.js'
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from '../../sessions/instructions/instructionFiles.js'
import type { InstructionSourceEntry } from '../../sessions/instruction-contracts/contracts.js'
import type { AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getSubscriptionName,
  isClaudeAISubscriber,
} from '../../models/sign-in/credentials/auth.js'
import type { GlobalConfig } from '../../platform/config/schema.js'
import { binaryName } from '../../platform/config/derived.js'
import { getCwd } from '../../platform/files/cwd.js'
import { formatNumber } from '../../platform/text/format.js'
import { AGENT_DESCRIPTIONS_THRESHOLD, getAgentDescriptionsTotalTokens } from './statusNoticeHelpers.js'
import { readPinnedStatus } from '../../sessions/mneme/mnemeFrontPage.js'
import { mnemeEnabled } from '../../sessions/mneme/mnemeGates.js'
import { formatTextSize } from '../../sessions/mneme/mnemeUsage.js'
import { passedOver } from '../../platform/errors/passedOver.js'


type StatusNoticeType = 'warning' | 'info'

type StatusNoticeContext = {
  memoryFiles: InstructionSourceEntry[]
  config: GlobalConfig
  agentDefinitions?: AgentDefinitionsResult
}

type StatusNoticeDefinition = {
  id: string
  type: StatusNoticeType
  isActive: (context: StatusNoticeContext) => boolean
  render: (context: StatusNoticeContext) => React.ReactNode
}

function shortenMemoryPath(filePath: string): string {
  const cwd = getCwd()
  return filePath.startsWith(cwd) ? relative(cwd, filePath) : filePath
}

function describeTokenSource(source: string): string {
  return source === 'claude.ai' ? `your ${getSubscriptionName()} login` : source
}

const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: (context: StatusNoticeContext) => getLargeMemoryFiles(context.memoryFiles).length > 0,
  render: (context: StatusNoticeContext) => {
    const largeFiles = getLargeMemoryFiles(context.memoryFiles)
    if (largeFiles.length === 0) return null
    return (
      <Box flexDirection="column">
        {largeFiles.map(file => (
          <Text key={file.path} color="warning" wrap="truncate-middle">
            {GLYPH.warn} Large memory file slows every session:{' '}
            <Text bold>{shortenMemoryPath(file.path)}</Text> (
            {formatNumber(file.content.length)} chars &gt; {formatNumber(MAX_MEMORY_CHARACTER_COUNT)}){' '}
            <Text dimColor>See /memory</Text>
          </Text>
        ))}
      </Box>
    )
  },
}

const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: (context: StatusNoticeContext) =>
    getAgentDescriptionsTotalTokens(context.agentDefinitions) > AGENT_DESCRIPTIONS_THRESHOLD,
  render: (context: StatusNoticeContext) => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions)
    return (
      <Text color="warning">
        {GLYPH.warn} Large cumulative agent descriptions slow every session (~
        {formatNumber(totalTokens)} tokens &gt; {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)}){' '}
        <Text dimColor>See /agents</Text>
      </Text>
    )
  },
}

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

const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    try {
      if (!getApiKeyFromConfigOrMacOSKeychain()) return false
      const { source } = getAnthropicApiKeyWithSource({
        skipRetrievingKeyFromApiKeyHelper: true,
      })
      return source === 'ANTHROPIC_API_KEY' || source === 'credentials.keyCommand'
    } catch (error) {
      passedOver(error)
      return false
    }
  },
  render: () => {
    const { source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    return (
      <Box marginTop={1}>
        <Text color="warning">
          {GLYPH.warn} {source} is being used instead of Mercury's own login key. Unset it, or run
          `{binaryName()} /logout` and log in again.
        </Text>
      </Box>
    )
  },
}

const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    try {
      const tokenSource = getAuthTokenSource().source
      const { source: apiKeySource } = getAnthropicApiKeyWithSource({
        skipRetrievingKeyFromApiKeyHelper: true,
      })
      if (tokenSource === 'none' || apiKeySource === 'none') return false
      if (tokenSource === 'credentials.keyCommand' && apiKeySource === 'credentials.keyCommand') {
        return false
      }
      return true
    } catch (error) {
      passedOver(error)
      return false
    }
  },
  render: () => {
    const tokenSource = getAuthTokenSource().source
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    const bin = binaryName()
    const describedToken = describeTokenSource(tokenSource)
    const tokenRemedy =
      apiKeySource === 'ANTHROPIC_API_KEY'
        ? `unset ANTHROPIC_API_KEY, or run \`${bin} /logout\`, decline the API-key approval, and log in again`
        : apiKeySource === 'credentials.keyCommand'
          ? 'unset the credentials.keyCommand setting'
          : `run \`${bin} /logout\``
    const keyRemedy =
      tokenSource === 'claude.ai'
        ? `run \`${bin} /logout\` to sign out of ${describedToken}`
        : `unset ${tokenSource}`
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="warning">
          {GLYPH.warn} Both an auth token ({describedToken}) and an API key ({apiKeySource})
          are set — one silently outranks the other.
        </Text>
        <Box flexDirection="column" paddingLeft={3}>
          <Text>{`Trying to use ${describedToken}? ${tokenRemedy}.`}</Text>
          <Text>{`Trying to use the API key (${apiKeySource})? ${keyRemedy}.`}</Text>
        </Box>
      </Box>
    )
  },
}

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
  return statusNoticeDefinitions.filter(notice => notice.isActive(context))
}

import { relative } from 'node:path'

import React from 'react'

import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { Box, Text } from '../ink.js'
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from '../services/instructions/engine.js'
import type { InstructionSourceEntry } from '../services/instructions/contracts.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getSubscriptionName,
  isClaudeAISubscriber,
} from './auth.js'
import type { GlobalConfig } from './config/schema.js'
import { binaryName } from './config/derived.js'
import { getCwd } from './cwd.js'
import { formatNumber } from './format.js'
import { AGENT_DESCRIPTIONS_THRESHOLD, getAgentDescriptionsTotalTokens } from './statusNoticeHelpers.js'

/**
 * The registry of conditional warning notices shown on the status surface.
 *
 * Rendering grammar: every notice row leads with the warning-toned,
 * width-stable geometric warning glyph (the usual ambiguous-width warning
 * sign renders two cells wide on some terminals and desynchronises the
 * column). The three auth notices carry one blank line of top margin; the
 * two size notices carry none.
 *
 * The two API-key probes are WRAPPED: the key resolver raises in a keyless
 * environment, and an exception escaping an activity predicate takes down
 * every keyless boot. Predicates must stay total.
 */

export type StatusNoticeType = 'warning' | 'info'

export type StatusNoticeContext = {
  config: GlobalConfig
  agentDefinitions?: AgentDefinitionsResult
  memoryFiles: InstructionSourceEntry[]
}

export type StatusNoticeDefinition = {
  id: string
  type: StatusNoticeType
  isActive: (context: StatusNoticeContext) => boolean
  render: (context: StatusNoticeContext) => React.ReactNode
}

function shortenMemoryPath(filePath: string): string {
  const cwd = getCwd()
  return filePath.startsWith(cwd) ? relative(cwd, filePath) : filePath
}

/** The display name of an auth-token source; the subscription login shows its product name. */
function describeTokenSource(source: string): string {
  return source === 'claude.ai' ? `your ${getSubscriptionName()} login` : source
}

const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: (context: StatusNoticeContext) => getLargeMemoryFiles(context.memoryFiles).length > 0,
  render: (context: StatusNoticeContext) => (
    <Box flexDirection="column">
      {getLargeMemoryFiles(context.memoryFiles).map(file => (
        <Text color="warning" key={file.path}>
          {GLYPH.warn} Large memory file slows every session: <Text bold>{shortenMemoryPath(file.path)}</Text> (
          {formatNumber(file.content.length)} chars {'>'} {formatNumber(MAX_MEMORY_CHARACTER_COUNT)}){' '}
          <Text dimColor>See /memory</Text>
        </Text>
      ))}
    </Box>
  ),
}

const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: (context: StatusNoticeContext) =>
    getAgentDescriptionsTotalTokens(context.agentDefinitions) > AGENT_DESCRIPTIONS_THRESHOLD,
  render: (context: StatusNoticeContext) => (
    <Text color="warning">
      {GLYPH.warn} Large cumulative agent descriptions slow every session (~
      {formatNumber(getAgentDescriptionsTotalTokens(context.agentDefinitions))} tokens {'>'}{' '}
      {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)}) <Text dimColor>See /agents</Text>
    </Text>
  ),
}

const claudeAiExternalTokenNotice: StatusNoticeDefinition = {
  id: 'claude-ai-external-token',
  type: 'warning',
  // Deliberately unwrapped: this predicate never calls the throwing key
  // resolver.
  isActive: (context: StatusNoticeContext) => {
    void context
    if (!isClaudeAISubscriber()) return false
    const tokenSource = getAuthTokenSource().source
    return tokenSource === 'ANTHROPIC_AUTH_TOKEN' || tokenSource === 'apiKeyHelper'
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
  isActive: (context: StatusNoticeContext) => {
    void context
    try {
      // A stored key exists AND something else outranks it. The probe asks
      // the resolver to skip the key helper so the probe itself stays
      // side-effect free, and the whole probe is wrapped: in a keyless
      // environment the resolver raises.
      const storedKey = getApiKeyFromConfigOrMacOSKeychain()
      if (storedKey === null) return false
      const resolved = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
      return resolved.source === 'ANTHROPIC_API_KEY' || resolved.source === 'apiKeyHelper'
    } catch {
      return false
    }
  },
  render: (context: StatusNoticeContext) => {
    void context
    // Safe unguarded: runs only after the predicate returned true.
    const resolved = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
    return (
      <Box marginTop={1}>
        <Text color="warning">
          {GLYPH.warn} {resolved.source} is being used instead of Mercury's own login key. Unset it, or run
          `{binaryName()} /logout` and log in again.
        </Text>
      </Box>
    )
  },
}

const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: (context: StatusNoticeContext) => {
    void context
    try {
      // Both an API key and an auth token are configured (and not both
      // from the key helper). Wrapped for the same keyless-boot reason as
      // the API-key conflict probe; getAnthropicApiKeyWithSource raises
      // with no key anywhere.
      const apiKeySource = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source
      const tokenSource = getAuthTokenSource().source
      if (apiKeySource === 'none' || tokenSource === 'none') return false
      return !(apiKeySource === 'apiKeyHelper' && tokenSource === 'apiKeyHelper')
    } catch {
      return false
    }
  },
  render: (context: StatusNoticeContext) => {
    void context
    const apiKeySource = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source
    const tokenSource = getAuthTokenSource().source
    const tokenIsSubscription = tokenSource === 'claude.ai'
    const tokenRemedy =
      apiKeySource === 'ANTHROPIC_API_KEY'
        ? `unset ANTHROPIC_API_KEY, or run \`${binaryName()} /logout\`, decline the API-key approval, and log in again`
        : apiKeySource === 'apiKeyHelper'
          ? 'unset the apiKeyHelper setting'
          : `run \`${binaryName()} /logout\``
    const keyRemedy = tokenIsSubscription
      ? `run \`${binaryName()} /logout\` to sign out of ${describeTokenSource(tokenSource)}`
      : `unset ${tokenSource}`
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="warning">
          {GLYPH.warn} Both an auth token ({describeTokenSource(tokenSource)}) and an API key ({apiKeySource})
          are set — one silently outranks the other.
        </Text>
        <Box flexDirection="column" paddingLeft={3}>
          <Text color="warning">Trying to use {describeTokenSource(tokenSource)}? {tokenRemedy}.</Text>
          <Text color="warning">Trying to use the API key ({apiKeySource})? {keyRemedy}.</Text>
        </Box>
      </Box>
    )
  },
}

/** The ordered registry; the filter preserves this order. */
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [
  largeMemoryFilesNotice,
  largeAgentDescriptionsNotice,
  claudeAiExternalTokenNotice,
  apiKeyConflictNotice,
  bothAuthMethodsNotice,
]

export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => notice.isActive(context))
}

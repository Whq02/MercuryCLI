import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Ansi } from '../../ink/Ansi.js'
import { StatusIcon } from '../design-system/StatusIcon.js'
import { STATE_STYLE } from '../mercury-ui/theme.js'
import { useAppState } from '../../state/AppState.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { detectUnreachableRules } from '../../utils/permissions/shadowedRuleDetection.js'
import { permissionRuleSourceDisplayString } from '../../utils/permissions/decision/rules.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionRuleValue, PermissionUpdate } from '../../types/permissions.js'

/** One debug row: a right-aligned dimmed label in a fixed 10-column gutter. */
function DebugRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box gap={1}>
      <Box width={10} flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}

/** Every rule value inside addRules updates, in order. */
function ruleValuesOf(updates: PermissionUpdate[] | undefined): PermissionRuleValue[] {
  const values: PermissionRuleValue[] = []
  for (const update of updates ?? []) {
    if (update.type === 'addRules') values.push(...update.rules)
  }
  return values
}

function directoriesOf(updates: PermissionUpdate[] | undefined): string[] {
  const dirs: string[] = []
  for (const update of updates ?? []) {
    if (update.type === 'addDirectories') dirs.push(...update.directories)
  }
  return dirs
}

/** The LAST mode-setting update wins for display. */
type SetModeUpdate = Extract<PermissionUpdate, { type: 'setMode' }>
function lastModeOf(updates: PermissionUpdate[] | undefined): SetModeUpdate['mode'] | undefined {
  let mode: SetModeUpdate['mode'] | undefined
  for (const update of updates ?? []) {
    if (update.type === 'setMode') mode = update.mode
  }
  return mode
}

/**
 * Render one decision reason. `nested` marks the one-level recursion inside a
 * per-subcommand set — a nested subcommand set is never expanded again.
 */
function ReasonView({
  reason,
  nested = false,
}: {
  reason: PermissionDecisionReason | undefined
  nested?: boolean
}): React.ReactNode {
  // An absent reason renders the literal word "undefined".
  if (!reason) return <Text>undefined</Text>
  switch (reason.type) {
    case 'rule':
      return (
        <Text>
          <Text bold>{permissionRuleValueToString(reason.rule.ruleValue)}</Text> from{' '}
          {permissionRuleSourceDisplayString(reason.rule.source)}
        </Text>
      )
    case 'mode':
      // The title alone — the old `{title} mode` suffix doubled the word for
      // every title that already ends in "Mode" ("Plan Mode mode"; after the
      // renames, three of six titles would).
      return <Text>{permissionModeTitle(reason.mode)}</Text>
    case 'sandboxOverride':
      return <Text>Permission is needed to run outside the sandbox</Text>
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return <Text>{reason.reason}</Text>
    case 'asyncAgent':
      return <Text>{reason.reason}</Text>
    case 'permissionPromptTool':
      return (
        <Text>
          <Text bold>{reason.permissionPromptToolName}</Text> permission prompt tool
        </Text>
      )
    case 'hook':
      return (
        <Text>
          <Text bold>{reason.hookName}</Text> hook
          {reason.reason ? `: ${reason.reason}` : ''}
        </Text>
      )
    case 'subcommandResults': {
      if (nested) return <Text>{''}</Text>
      const rows: React.ReactNode[] = []
      for (const [subcommand, result] of reason.reasons.entries()) {
        const allowed = result.behavior === 'allow'
        const subReason =
          'decisionReason' in result ? result.decisionReason : undefined
        const suggestions =
          result.behavior === 'ask' ? ruleValuesOf(result.suggestions) : []
        rows.push(
          <Box key={subcommand} flexDirection="column">
            <Box gap={1}>
              <StatusIcon status={allowed ? 'success' : 'error'} />
              <Text>{subcommand}</Text>
            </Box>
            <Box paddingLeft={2}>
              <ReasonView reason={subReason} nested />
            </Box>
            {result.behavior === 'ask' && suggestions.length > 0 ? (
              <Box paddingLeft={2}>
                <Text>
                  suggested rules:{' '}
                  <Text bold>
                    {suggestions.map(permissionRuleValueToString).join(', ')}
                  </Text>
                </Text>
              </Box>
            ) : null}
          </Box>,
        )
      }
      return <Box flexDirection="column">{rows}</Box>
    }
    default: {
      // An unrecognised reason kind renders its display string through Ansi
      // — ANSI-coloured reasons keep their colour.
      const display = String((reason as { reason?: unknown }).reason ?? '')
      return (
        <Text>
          <Ansi>{display}</Ansi>
        </Text>
      )
    }
  }
}

/**
 * The raw permission decision, its suggestions, and any unreachable-rule
 * warnings — shown on the shell cards behind the debug keybinding.
 */
export function PermissionDecisionDebugInfo({
  permissionResult,
  toolName,
}: {
  permissionResult: PermissionDecision | PermissionResult
  toolName?: string
}): React.ReactNode {
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)

  const suggestions =
    'suggestions' in permissionResult ? permissionResult.suggestions : undefined
  const suggestedRules = ruleValuesOf(suggestions)
  const suggestedDirs = directoriesOf(suggestions)
  const suggestedMode = lastModeOf(suggestions)
  const reason =
    'decisionReason' in permissionResult ? permissionResult.decisionReason : undefined

  // The shadowed-rule detector runs over the WHOLE context; the sandbox
  // auto-allow flag mirrors what the engine itself would use.
  const sandboxAutoAllowEnabled =
    SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled()
  let unreachable = detectUnreachableRules(toolPermissionContext, { sandboxAutoAllowEnabled })
  if (suggestedRules.length > 0) {
    unreachable = unreachable.filter(candidate =>
      suggestedRules.some(
        suggested =>
          suggested.toolName === candidate.rule.ruleValue.toolName &&
          suggested.ruleContent === candidate.rule.ruleValue.ruleContent,
      ),
    )
  } else if (toolName !== undefined) {
    unreachable = unreachable.filter(
      candidate => candidate.rule.ruleValue.toolName === toolName,
    )
  }

  const hasSuggestionContent =
    suggestedRules.length > 0 || suggestedDirs.length > 0 || suggestedMode !== undefined

  return (
    <Box flexDirection="column">
      <DebugRow label="Behavior">
        <Text>{permissionResult.behavior}</Text>
      </DebugRow>
      {permissionResult.behavior !== 'allow' && 'message' in permissionResult ? (
        <DebugRow label="Message">
          <Text>{permissionResult.message}</Text>
        </DebugRow>
      ) : null}
      <DebugRow label="Reason">
        <ReasonView reason={reason} />
      </DebugRow>
      <DebugRow label="Suggestions">
        {!hasSuggestionContent ? (
          <Text>None</Text>
        ) : (
          <Box flexDirection="column">
            {suggestedRules.length > 0 ? (
              <Box flexDirection="column">
                <Text>Rules</Text>
                {suggestedRules.map((rule, index) => (
                  <Text key={index}> - {permissionRuleValueToString(rule)}</Text>
                ))}
              </Box>
            ) : null}
            {suggestedDirs.length > 0 ? (
              <Box flexDirection="column">
                <Text>Directories</Text>
                {suggestedDirs.map((dir, index) => (
                  <Text key={index}> - {dir}</Text>
                ))}
              </Box>
            ) : null}
            {suggestedMode !== undefined ? (
              <Text>Mode: {permissionModeTitle(suggestedMode)}</Text>
            ) : null}
          </Box>
        )}
      </DebugRow>
      {unreachable.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="warning">
            {STATE_STYLE.gated.glyph} Unreachable rules ({unreachable.length})
          </Text>
          {unreachable.map((finding, index) => (
            <Box key={index} flexDirection="column" paddingLeft={2}>
              <Text color="warning">
                {permissionRuleValueToString(finding.rule.ruleValue)}
              </Text>
              <Box paddingLeft={2}>
                <Text dimColor>{finding.reason}</Text>
              </Box>
              <Box paddingLeft={2}>
                <Text dimColor>Fix: {finding.fix}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

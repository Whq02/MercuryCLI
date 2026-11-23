import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { Ansi } from '../../screen/renderer/Ansi.js'
import { StatusIcon } from '../../screen/theme/StatusIcon.js'
import { STATE_STYLE } from '../../screen/widgets/theme.js'
import { useAppState } from '../../screen/app-state/AppState.js'
import { detectUnreachableRules } from '../rules/shadowedRuleDetection.js'
import { ruleSourceWords } from '../rules/ruleReason.js'
import { permissionRuleValueToString } from '../rules/permissionRuleParser.js'
import { permissionModeTitle } from '../rules/permissionMode.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionResult,
} from '../rules/permissionResult.js'
import type { PermissionRuleValue, PermissionUpdate } from '../rules/permissions.js'
import { BYPASSED_ASK_ROAD_WORDS } from '../rules/permissions.js'

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
        <Text dimColor wrap="truncate-end">{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  )
}

function ruleValuesOf(updates: PermissionUpdate[] | undefined): PermissionRuleValue[] {
  const values: PermissionRuleValue[] = []
  for (const update of updates ?? []) {
    if (update.type === 'addRules') values.push(...update.rules)
  }
  return values
}

type SetModeUpdate = Extract<PermissionUpdate, { type: 'setMode' }>
function lastModeOf(updates: PermissionUpdate[] | undefined): SetModeUpdate['mode'] | undefined {
  let mode: SetModeUpdate['mode'] | undefined
  for (const update of updates ?? []) {
    if (update.type === 'setMode') mode = update.mode
  }
  return mode
}

function behaviorStatus(behavior: PermissionResult['behavior']): 'success' | 'error' | 'warning' | 'info' {
  switch (behavior) {
    case 'allow':
      return 'success'
    case 'deny':
      return 'error'
    case 'ask':
      return 'warning'
    case 'passthrough':
      return 'info'
  }
}

function DecisionReasonView({
  decisionReason,
  nested = false,
}: {
  decisionReason: PermissionDecisionReason | undefined
  nested?: boolean
}): React.ReactNode {
  if (decisionReason === undefined) {
    return <Text dimColor>undefined</Text>
  }
  switch (decisionReason.type) {
    case 'rule':
      return (
        <Text wrap="truncate-middle">
          the rule <Text bold>{permissionRuleValueToString(decisionReason.rule.ruleValue)}</Text>{' '}
          {ruleSourceWords(decisionReason.rule.source)}
        </Text>
      )
    case 'mode':
      return <Text>{permissionModeTitle(decisionReason.mode)}</Text>
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
    case 'guard':
    case 'asyncAgent':
      return <Text wrap="truncate-middle">{decisionReason.reason}</Text>
    case 'bypassedAsk':
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-middle">
            {permissionModeTitle(decisionReason.mode)} allowed it;{' '}
            {BYPASSED_ASK_ROAD_WORDS[decisionReason.road]} would have asked:
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            <DecisionReasonView decisionReason={decisionReason.reason} nested />
          </Box>
        </Box>
      )
    case 'permissionPromptTool':
      return (
        <Text wrap="truncate-middle">
          <Text bold>{decisionReason.permissionPromptToolName ?? 'unknown'}</Text> permission prompt tool
        </Text>
      )
    case 'hook':
      return (
        <Text wrap="truncate-middle">
          <Text bold>{decisionReason.hookName}</Text> hook
          {decisionReason.reason ? `: ${decisionReason.reason}` : ''}
        </Text>
      )
    case 'subcommandResults': {
      const entries = Array.from(decisionReason.reasons.entries())
      return (
        <Box flexDirection="column">
          {entries.map(([subcommand, result], index) => {
            const subRules =
              result.behavior === 'ask' || result.behavior === 'passthrough'
                ? ruleValuesOf(result.suggestions)
                : []
            return (
              <Box key={`${subcommand}-${index}`} flexDirection="column">
                <Box gap={1}>
                  <StatusIcon status={behaviorStatus(result.behavior)} />
                  <Text wrap="truncate-end">{subcommand}</Text>
                </Box>
                <Box paddingLeft={2} flexDirection="column">
                  <DecisionReasonView decisionReason={result.decisionReason} nested />
                  {!nested && subRules.length > 0 ? (
                    <Text dimColor wrap="truncate-end">
                      suggested rules:{' '}
                      <Text bold>{subRules.map(permissionRuleValueToString).join(', ')}</Text>
                    </Text>
                  ) : null}
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    default:
      return (
        <Text wrap="truncate-middle">
          <Ansi>{JSON.stringify(decisionReason)}</Ansi>
        </Text>
      )
  }
}

export function PermissionDecisionDebugInfo({
  permissionResult,
  toolName,
}: {
  permissionResult: PermissionDecision | PermissionResult
  toolName?: string
}): React.ReactNode {
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const suggestions =
    permissionResult.behavior === 'ask' || permissionResult.behavior === 'passthrough'
      ? permissionResult.suggestions
      : undefined
  const suggestedRules = ruleValuesOf(suggestions)
  const suggestedMode = lastModeOf(suggestions)

  const suggestedToolNames = new Set(suggestedRules.map(rule => rule.toolName))
  const unreachableRules = detectUnreachableRules(toolPermissionContext).filter(item => {
    if (suggestedToolNames.size > 0) {
      return suggestedToolNames.has(item.rule.ruleValue.toolName)
    }
    return toolName !== undefined && item.rule.ruleValue.toolName === toolName
  })

  return (
    <Box flexDirection="column">
      <DebugRow label="Behavior">
        <Text>{permissionResult.behavior}</Text>
      </DebugRow>
      {permissionResult.behavior !== 'allow' && permissionResult.message ? (
        <DebugRow label="Message">
          <Text wrap="truncate-middle">{permissionResult.message}</Text>
        </DebugRow>
      ) : null}
      <DebugRow label="Reason">
        <DecisionReasonView decisionReason={permissionResult.decisionReason} />
      </DebugRow>
      <DebugRow label="Suggestions">
        {suggestedRules.length === 0 && suggestedMode === undefined ? (
          <Text dimColor>None</Text>
        ) : (
          <Box flexDirection="column">
            {suggestedRules.length > 0 ? (
              <>
                <Text>Rules</Text>
                {suggestedRules.map((rule, index) => (
                  <Text key={index}> - {permissionRuleValueToString(rule)}</Text>
                ))}
              </>
            ) : null}
            {suggestedMode !== undefined ? (
              <Text>Mode: {permissionModeTitle(suggestedMode)}</Text>
            ) : null}
          </Box>
        )}
      </DebugRow>
      {unreachableRules.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="warning">
            {STATE_STYLE.gated.glyph} Unreachable rules ({unreachableRules.length})
          </Text>
          {unreachableRules.map((item, index) => (
            <Box key={index} flexDirection="column" paddingLeft={2}>
              <Text bold>{permissionRuleValueToString(item.rule.ruleValue)}</Text>
              <Text dimColor>{item.reason}</Text>
              <Text dimColor>Fix: {item.fix}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

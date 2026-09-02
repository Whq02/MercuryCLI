
import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import {
  KeyValueGrid,
  type KVRow,
  Panel,
  StateBadge,
  WarningBanner,
} from '../../components/mercury-ui/components.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { AMBER, FAINT, IVORY, SECOND } from '../../components/mercury-ui/theme.js'
import { logUnaryPermissionEvent } from '../../components/permissions/utils.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../../components/permissions/PermissionPrompt.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { PermissionRuleExplanation } from '../../components/permissions/PermissionRuleExplanation.js'
import { type UnaryEvent, usePermissionRequestLogging } from '../../components/permissions/hooks.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import {
  type CompileError,
  parseWorkflowScript,
  type ParsedWorkflow,
  type WorkflowMeta,
} from './compiler.js'

type WorkflowOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

function isCompileError(
  x: ParsedWorkflow | CompileError,
): x is CompileError {
  return (x as CompileError).ok === false
}

type WorkflowConsentInput = {
  script?: string
  name?: string
  description?: string
  scriptPath?: string
  args?: unknown
  resumeFromRunId?: string
}

function invocationSource(input: WorkflowConsentInput): {
  label: string
  ruleKey: string | undefined
} {
  if (input.scriptPath) return { label: 'script file', ruleKey: undefined }
  if (input.name) return { label: 'named workflow', ruleKey: input.name }
  return { label: 'inline script', ruleKey: undefined }
}

function previewMeta(
  input: WorkflowConsentInput,
): { meta: WorkflowMeta } | { error: string } | null {
  if (!input.script) return null
  const parsed = parseWorkflowScript(input.script)
  if (isCompileError(parsed)) return { error: parsed.error }
  return { meta: parsed.meta }
}

export function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const input = toolUseConfirm.input as WorkflowConsentInput

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const source = useMemo(() => invocationSource(input), [input])
  const preview = useMemo(() => previewMeta(input), [input])

  const meta =
    preview && 'meta' in preview ? preview.meta : undefined
  const parseError =
    preview && 'error' in preview ? preview.error : undefined

  const workflowName =
    meta?.name ?? input.name ?? (input.scriptPath ? input.scriptPath : '(inline)')
  const description = meta?.description ?? input.description ?? undefined
  const phases = meta?.phases ?? []

  const showAlwaysAllow =
    shouldShowAlwaysAllowOptions() && source.ruleKey !== undefined

  const options = useMemo<PermissionPromptOption<WorkflowOptionValue>[]>(() => {
    const result: PermissionPromptOption<WorkflowOptionValue>[] = [
      { label: 'Yes, run this workflow', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (showAlwaysAllow) {
      result.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for{' '}
            <Text bold>{source.ruleKey}</Text>
          </Text>
        ),
        value: 'yes-dont-ask-again',
      })
    }
    result.push({
      label: (
        <Text>
          No, and tell Mercury what to do differently <Text bold>(esc)</Text>
        </Text>
      ),
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })
    return result
  }, [showAlwaysAllow, source.ruleKey])

  function handleSelect(value: WorkflowOptionValue, feedback?: string) {
    switch (value) {
      case 'yes':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', !!feedback)
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      case 'yes-dont-ask-again': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', !!feedback)
        const ruleContent = source.ruleKey ?? input.name ?? ''
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: WORKFLOW_TOOL_NAME, ruleContent }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        break
      }
      case 'no':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject', !!feedback)
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        break
    }
  }

  const facts: KVRow[] = [
    { k: 'source', v: source.label, tone: SECOND },
    {
      k: 'phases',
      v: meta ? String(phases.length) : '—',
      tone: meta && phases.length ? IVORY : FAINT,
    },
    { k: 'args', v: input.args !== undefined ? 'provided' : 'none', tone: input.args !== undefined ? IVORY : FAINT },
  ]
  if (workflowName === 'daedalus' && input.args && typeof input.args === 'object') {
    const a = input.args as Record<string, unknown>
    const modelRow = (key: string, srcKey: string): string => {
      const v = typeof a[key] === 'string' ? (a[key] as string) : '(ask at preview)'
      const src = typeof a[srcKey] === 'string' && String(a[srcKey]).includes('boot-menu') ? ' · saved choice' : ''
      return v + src
    }
    facts.push({ k: 'planning', v: modelRow('model', 'modelSource'), tone: IVORY })
    facts.push({ k: 'building', v: modelRow('executorModel', 'executorModelSource'), tone: IVORY })
    facts.push({
      k: 'launch',
      v: a.accept === true ? 'ACCEPTED — the fleet dispatches' : 'preview only (no agents until accept=true)',
      tone: a.accept === true ? AMBER : SECOND,
    })
  }
  if (input.resumeFromRunId) {
    facts.push({ k: 'resume', v: input.resumeFromRunId, tone: AMBER, note: 'cached steps reused' })
  }

  return (
    <PermissionDialog title="Workflow" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Panel title={`${GLYPH.mission} ${workflowName}`} accentBorder>
          {description ? (
            <Text color={SECOND}>{truncateToLines(description, 2)}</Text>
          ) : (
            <Text color={FAINT}>(no description in meta)</Text>
          )}
          <Box marginTop={1}>
            <KeyValueGrid rows={facts} keyWidth={9} />
          </Box>
          {meta && phases.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={FAINT}>plan</Text>
              {phases.slice(0, 6).map((p, i) => (
                <Text key={i}>
                  <Text color={FAINT}>{GLYPH.prompt} </Text>
                  <Text color={IVORY}>{p.title}</Text>
                  {p.model ? <Text color={FAINT}> · {p.model}</Text> : null}
                </Text>
              ))}
              {phases.length > 6 ? (
                <Text color={FAINT}>  … {phases.length - 6} more</Text>
              ) : null}
            </Box>
          ) : null}
        </Panel>

        {parseError ? (
          <Box marginTop={1}>
            <WarningBanner tone="warn" title="Could not preview script" detail={truncateToLines(parseError, 1)} />
          </Box>
        ) : !meta ? (
          <Box marginTop={1}>
            <Text>
              <StateBadge state="gated" label="script not materialized" />
              <Text color={FAINT}> — review the run before allowing</Text>
            </Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text color={FAINT}>{truncateToLines(toolUseConfirm.description, 2)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <Text>Do you want to allow Mercury to run this workflow?</Text>
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect('no')}
        />
      </Box>
    </PermissionDialog>
  )
}

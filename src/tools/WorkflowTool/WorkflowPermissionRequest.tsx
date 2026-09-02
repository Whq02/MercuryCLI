// ============================================================================
//  WorkflowPermissionRequest — the workflow CONSENT dialog.
//
//  A Workflow tool-use asks for approval to RUN an orchestration script
//  (agent()/parallel()/pipeline()/phase()). Before this file existed the gate
//  in PermissionRequest.tsx resolved `WorkflowPermissionRequest ?? Fallback...`
//  to the bare FallbackPermissionRequest — a generic "Tool use" prompt that
//  showed nothing about the workflow itself. This is the warm-ink Mercury
//  replacement: it previews the workflow's identity (name / description /
//  phases) honestly from the materialized script, then offers allow/deny.
//
//  Drop-in: same PermissionRequestProps as every sibling
//  (FallbackPermissionRequest / WebFetchPermissionRequest / SkillPermission-
//  Request). Props matched verbatim — { toolUseConfirm, onDone, onReject,
//  verbose, workerBadge } — and the same onAllow/onReject/onDone handler trio
//  with logUnaryPermissionEvent. The framing is the `permission` role
//  (PermissionDialog), which Mercury's warm-ink overlay routes to the live
//  session accent (the left rail). Everything inside is built on the existing
//  mercury-ui primitives (Panel, StateBadge, KeyValueGrid, CommandRow,
//  WarningBanner) — zero new hex, no emoji, no raster.
//
//  Hand-written plain form (NOT React-Compiler `_c` output): a fresh source
//  file, so there is no `$[…]` cache to maintain.
// ============================================================================

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

// `isCompileError` is a private local in WorkflowTool.tsx — re-derive the
// discriminant here against the exported CompileError shape ({ ok: false }).
// ParsedWorkflow carries no `ok` field, so this cleanly separates the union.
function isCompileError(
  x: ParsedWorkflow | CompileError,
): x is CompileError {
  return (x as CompileError).ok === false
}

// The shape we read off toolUseConfirm.input. checkPermissions materializes the
// resolved `script` into updatedInput, so the consent dialog can preview what
// is about to run even for named/scriptPath invocations.
type WorkflowConsentInput = {
  script?: string
  name?: string
  description?: string
  scriptPath?: string
  args?: unknown
  resumeFromRunId?: string
}

// How the workflow was invoked — drives both the summary line and the
// allow-list eligibility (only NAMED workflows have a stable rule key;
// inline/scriptPath always re-prompt, matching WorkflowTool.checkPermissions).
function invocationSource(input: WorkflowConsentInput): {
  label: string
  ruleKey: string | undefined
} {
  if (input.scriptPath) return { label: 'script file', ruleKey: undefined }
  if (input.name) return { label: 'named workflow', ruleKey: input.name }
  return { label: 'inline script', ruleKey: undefined }
}

// Parse the materialized script into its meta block, honestly. Returns the meta
// when the script is present and parses, otherwise an error string we surface as
// a banner (never a fabricated preview).
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

  // The displayed workflow name: prefer the parsed meta.name, else the invoked
  // name, else a faithful "(inline)" placeholder — never a guess.
  const workflowName =
    meta?.name ?? input.name ?? (input.scriptPath ? input.scriptPath : '(inline)')
  const description = meta?.description ?? input.description ?? undefined
  const phases = meta?.phases ?? []

  // Allow-list option only when the loader allows it AND there is a stable rule
  // key (named workflow). Inline/scriptPath runs always re-prompt.
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
        // This branch is only reachable when source.ruleKey is defined (the
        // option is added only under that guard) — keep the rule scoped to the
        // workflow NAME, mirroring WorkflowTool.checkPermissions' ruleKey.
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

  // The honest fact table: source · phases · args · resume. Phase count reads
  // from the parsed meta; when the script could not be materialized/parsed the
  // grid stays truthful (phases shows "—") and a banner explains the gap.
  const facts: KVRow[] = [
    { k: 'source', v: source.label, tone: SECOND },
    {
      k: 'phases',
      v: meta ? String(phases.length) : '—',
      tone: meta && phases.length ? IVORY : FAINT,
    },
    { k: 'args', v: input.args !== undefined ? 'provided' : 'none', tone: input.args !== undefined ? IVORY : FAINT },
  ]
  // DAEDALUS: the operator's model choices are SHOWN at launch.
  // Provenance rides the value (explicit vs
  // boot-menu saved choice); accept=false runs are labeled preview-only.
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

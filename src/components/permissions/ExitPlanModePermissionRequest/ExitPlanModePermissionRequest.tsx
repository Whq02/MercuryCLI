import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, measureElement, type DOMElement } from '../../../ink.js'
import { Markdown } from '../../Markdown.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { consentBodyBudget, consentContentWidth, totalLineRows } from '../consentBodyBudget.js'
import { useShortcutDisplay } from '../../../keybindings/useShortcutDisplay.js'
import { Select } from '../../CustomSelect/select.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
  setHasExitedPlanMode,
  setNeedsPlanModeExitAttachment,
} from '../../../bootstrap/state.js'
import { useAppState, useSetAppState } from '../../../state/AppState.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../../tools/ExitPlanModeTool/constants.js'
import type { AllowedPrompt } from '../../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { createUserMessage } from '../../../utils/messages/factories.js'
import { generateSessionName } from '../../../commands/rename/generateSessionName.js'
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js'
import { getExternalEditor } from '../../../utils/editor.js'
import { toIDEDisplayName } from '../../../utils/ide.js'
import { editFileInEditor } from '../../../utils/promptEditor.js'
import { logError } from '../../../utils/log.js'
import { getDisplayPath } from '../../../utils/file.js'
import { getPlan, getPlanFilePath } from '../../../utils/plans.js'
import {
  getCurrentSessionTitle,
  saveAgentName,
  saveCustomTitle,
} from '../../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js'
import { maybeResizeAndDownsampleImageBlock } from '../../../utils/imageResizer.js'
import { useNotifications } from '../../../context/notifications.js'
import { getContextWindowForModel } from '../../../utils/model/capabilities.js'
import { getRuntimeMainLoopModel } from '../../../utils/model/model.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import {
  createPromptRuleContent,
  isClassifierPermissionsEnabled,
} from '../../../utils/permissions/bashClassifier.js'
import {
  getModeColor,
  toExternalPermissionMode,
  type PermissionMode,
} from '../../../utils/permissions/PermissionMode.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import type { ContentBlockParam } from '../../../types/wire.js'
import type { UUID } from 'node:crypto'
import type { Theme } from '../../../utils/theme.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type PlanOptionValue = 'yes-clear-context' | 'yes' | 'yes-manual' | 'no'

export function buildPermissionUpdates(
  mode: PermissionMode,
  allowedPrompts?: AllowedPrompt[],
): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [
    { type: 'setMode', mode: toExternalPermissionMode(mode), destination: 'session' },
  ]
  if (isClassifierPermissionsEnabled() && allowedPrompts && allowedPrompts.length > 0) {
    updates.push({
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: allowedPrompts.map(prompt => ({
        toolName: prompt.tool,
        ruleContent: createPromptRuleContent(prompt.prompt),
      })),
    })
  }
  return updates
}

export function buildPlanApprovalOptions({
  showClearContext,
  usedPercent,
  isAutoModeAvailable: _isAutoModeAvailable,
  isBypassPermissionsModeAvailable,
  onFeedbackChange,
  approveWithFeedbackChord = 'shift+n',
}: {
  showClearContext: boolean
  usedPercent: number | undefined
  isAutoModeAvailable: boolean
  isBypassPermissionsModeAvailable: boolean
  onFeedbackChange: (feedback: string) => void
  approveWithFeedbackChord?: string
}): OptionWithDescription<PlanOptionValue>[] {
  const elevationLabel = isBypassPermissionsModeAvailable
    ? 'enter sovereign mode'
    : 'enter implement mode'
  const options: OptionWithDescription<PlanOptionValue>[] = []
  if (showClearContext) {
    options.push({
      label: (
        <Text>
          Yes, clear context{usedPercent !== undefined ? ` (${usedPercent}% used)` : ''} and{' '}
          {elevationLabel}
        </Text>
      ),
      value: 'yes-clear-context',
    })
  }
  options.push({ label: `Yes, and ${elevationLabel}`, value: 'yes' })
  options.push({ label: 'Yes, and manually approve edits', value: 'yes-manual' })
  options.push({
    type: 'input',
    label: 'No, keep planning',
    value: 'no',
    onChange: onFeedbackChange,
    placeholder: 'tell Mercury what to change in the plan',
    description: `${approveWithFeedbackChord} approves with this feedback instead of rejecting`,
  })
  return options
}

type SetAppState = ReturnType<typeof useSetAppState>

export function autoNameSessionFromPlan(
  plan: string,
  _setAppState: SetAppState,
  isClearContext: boolean,
): void {
  void (async () => {
    try {
      if (isSessionPersistenceDisabled()) return
      const settings = getSettings_DEPRECATED() as { cleanupPeriodDays?: number }
      if (settings.cleanupPeriodDays === 0) return
      if (!isClearContext && getCurrentSessionTitle(getSessionId())) return
      const name = await generateSessionName(
        [createUserMessage({ content: plan.slice(0, 1000) })],
        new AbortController().signal,
      )
      if (name === null) return
      if (!isClearContext && getCurrentSessionTitle(getSessionId())) return
      const sessionId = getSessionId() as unknown as UUID
      const transcriptPath = getTranscriptPath()
      await saveCustomTitle(sessionId, name, transcriptPath, 'auto')
      await saveAgentName(sessionId, name, transcriptPath, 'auto')
    } catch (error) {
      logError(error)
    }
  })()
}

type PastedImage = { id: number; content: string; mediaType: string }

export function ExitPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
  setStickyFooter,
}: PermissionRequestProps): React.ReactNode {
  const setAppState = useSetAppState()
  const showClearContext = useAppState(
    state => state.settings.showClearContextOnStrategyAccept ?? false,
  )
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const currentMode = toolPermissionContext.mode
  const bypassAvailable = toolPermissionContext.isBypassPermissionsModeAvailable ?? false
  const { addNotification } = useNotifications()

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const isV2 = toolUseConfirm.tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME
  void isV2
  const input = toolUseConfirm.input as { plan?: string; allowedPrompts?: AllowedPrompt[] }
  const allowedPrompts = input.allowedPrompts
  const [plan, setPlan] = useState<string>(
    () => input.plan ?? getPlan() ?? 'Write the plan to the plan file first.',
  )
  const [planLocallyEdited, setPlanLocallyEdited] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [savedConfirmationVisible, setSavedConfirmationVisible] = useState(false)
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
  const nextImageId = useRef(1)

  const planIsEmpty = (input.plan ?? getPlan() ?? '').trim() === ''

  const { columns, rows: termRows } = useTerminalSize()
  const [planExpanded, setPlanExpanded] = useState(false)
  useKeybinding('confirm:toggleFullPreview', () => setPlanExpanded(prev => !prev), {
    context: 'Confirmation',
  })
  const planBudget = consentBodyBudget(termRows)
  const planBoxRef = useRef<DOMElement | null>(null)
  const [planPaintedRows, setPlanPaintedRows] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (planBoxRef.current) {
      const { height } = measureElement(planBoxRef.current)
      if (height > 0 && height !== planPaintedRows) setPlanPaintedRows(height)
    }
  })
  const planRows =
    planPaintedRows ?? totalLineRows(plan.split('\n'), consentContentWidth(columns, 0))
  const planCapped = !planExpanded && planRows > planBudget
  const planHiddenRows = planCapped ? planRows - planBudget : 0

  const approveChord = useShortcutDisplay('confirm:approveWithFeedback', 'Confirmation', 'shift+n')

  const usedPercent = useMemo(() => {
    if (!showClearContext) return undefined
    const usage = toolUseConfirm.assistantMessage.message.usage
    if (!usage) return undefined
    const used =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    const window = getContextWindowForModel(
      getRuntimeMainLoopModel({ permissionMode: currentMode, mainLoopModel: getFocusedSessionConnector().modelFacts().main }),
    )
    if (!window) return undefined
    return Math.round((used / window) * 100)
  }, [showClearContext, toolUseConfirm.assistantMessage, currentMode])

  const options = useMemo(
    () =>
      buildPlanApprovalOptions({
        showClearContext,
        usedPercent,
        isAutoModeAvailable: false,
        isBypassPermissionsModeAvailable: bypassAvailable,
        onFeedbackChange: setFeedback,
        approveWithFeedbackChord: approveChord,
      }),
    [showClearContext, usedPercent, bypassAvailable, approveChord],
  )


  const rejectOutright = useCallback(() => {
    onDone()
    onReject()
    toolUseConfirm.onReject()
  }, [onDone, onReject, toolUseConfirm])

  const handleApproval = useCallback(
    (mode: PermissionMode, clearContext: boolean) => {
      autoNameSessionFromPlan(plan, setAppState, clearContext)
      if (clearContext) {
        const transcriptBeforeClear = getTranscriptPath()
        const lines = [
          'Implement the plan.',
          `Details from the planning conversation are in the transcript at ${transcriptBeforeClear} if you need them.`,
        ]
        if (isAgentSwarmsEnabled()) {
          lines.push('For parallelisable work, consider creating a team with the team-creation tool.')
        }
        const typed = feedback.trim()
        if (typed !== '') {
          lines.push('', 'User feedback on this plan:', typed)
        }
        setAppState(prev => ({
          ...prev,
          initialMessage: {
            message: createUserMessage({ content: lines.join('\n') }),
            clearContext: true,
            mode: toExternalPermissionMode(mode),
            allowedPrompts,
          },
        }))
        setHasExitedPlanMode(true)
        onDone()
        onReject()
        toolUseConfirm.onReject()
        return
      }
      setHasExitedPlanMode(true)
      setNeedsPlanModeExitAttachment(true)
      onDone()
      const updatedInput = planLocallyEdited ? { plan } : {}
      const typed = feedback.trim() || undefined
      toolUseConfirm.onAllow(updatedInput, buildPermissionUpdates(mode, allowedPrompts), typed)
    },
    [
      plan,
      feedback,
      planLocallyEdited,
      allowedPrompts,
      setAppState,
      onDone,
      onReject,
      toolUseConfirm,
    ],
  )

  const handleRejectWithFeedback = useCallback(() => {
    const typed = feedback.trim()
    if (typed === '' && pastedImages.length === 0) {
      return
    }
    void (async () => {
      const blocks: ContentBlockParam[] = []
      for (const image of pastedImages) {
        blocks.push(
          (await maybeResizeAndDownsampleImageBlock({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.content },
          } as never)) as unknown as ContentBlockParam,
        )
      }
      const text = typed === '' ? 'See the attached image.' : typed
      toolUseConfirm.onReject(text, blocks.length > 0 ? blocks : undefined)
      onReject()
      onDone()
    })()
  }, [feedback, pastedImages, toolUseConfirm, onReject, onDone])

  const handleChange = useCallback(
    (value: PlanOptionValue) => {
      switch (value) {
        case 'yes-clear-context':
          handleApproval(bypassAvailable ? 'sovereign' : 'implement', true)
          break
        case 'yes':
          handleApproval(bypassAvailable ? 'sovereign' : 'implement', false)
          break
        case 'yes-manual':
          handleApproval('default', false)
          break
        case 'no':
          handleRejectWithFeedback()
          break
      }
    },
    [handleApproval, handleRejectWithFeedback, bypassAvailable],
  )


  const editorName = toIDEDisplayName(getExternalEditor() ?? null)
  const planFilePath = getPlanFilePath()
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useKeybinding(
    'chat:externalEditor',
    () => {
      void (async () => {
        try {
          const result = await editFileInEditor(planFilePath)
          const edited = result.content
          if (edited !== null && edited !== undefined) {
            if (edited !== plan) {
              setPlan(edited)
              setPlanLocallyEdited(true)
            }
            setSavedConfirmationVisible(true)
            if (savedTimer.current) clearTimeout(savedTimer.current)
            savedTimer.current = setTimeout(() => setSavedConfirmationVisible(false), 5000)
          }
        } catch (error) {
          addNotification({
            key: 'plan-editor-error',
            text: `Could not open the plan in ${editorName}: ${error instanceof Error ? error.message : String(error)}`,
            priority: 'high',
          } as never)
        }
      })()
    },
    { context: 'Confirmation' },
  )
  const [rejectionFieldFocused, setRejectionFieldFocused] = useState(false)
  useKeybinding(
    'confirm:approveWithFeedback',
    () => {
      handleApproval('implement', showClearContext)
    },
    { context: 'Confirmation', isActive: !rejectionFieldFocused },
  )

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    },
    [],
  )


  const handleImagePaste = useCallback((content: string, mediaType?: string) => {
    const id = nextImageId.current++
    setPastedImages(current => [
      ...current,
      { id, content, mediaType: mediaType ?? 'image/png' },
    ])
  }, [])
  const handleRemoveImage = useCallback((id: number) => {
    setPastedImages(current => current.filter(image => image.id !== id))
  }, [])


  const handleChangeRef = useRef(handleChange)
  handleChangeRef.current = handleChange
  const stickyActive = Boolean(setStickyFooter) && !planIsEmpty

  const editorHint = (
    <Text dimColor>
      ctrl+g edit in {editorName} · {getDisplayPath(planFilePath)}
      {savedConfirmationVisible ? ' · saved' : ''}
    </Text>
  )

  useEffect(() => {
    if (!setStickyFooter) return
    if (planIsEmpty) return
    setRejectionFieldFocused(false)
    setStickyFooter(
      <Box flexDirection="column">
        <Text bold>Ready to code?</Text>
        <Select
          options={options}
          onChange={value => handleChangeRef.current(value as PlanOptionValue)}
          onCancel={() => rejectOutright()}
          onFocus={value => setRejectionFieldFocused(value === 'no')}
          onImagePaste={handleImagePaste}
          onRemoveImage={handleRemoveImage}
          pastedContents={pastedImages as never}
        />
        {editorHint}
      </Box>,
    )
    return () => setStickyFooter(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    setStickyFooter,
    planIsEmpty,
    options,
    pastedImages,
    editorName,
    planFilePath,
    savedConfirmationVisible,
  ])


  if (planIsEmpty) {
    return (
      <PermissionDialog
        title="Exit strategy mode?"
        color={getModeColor('strategy') as keyof Theme}
        workerBadge={workerBadge}
      >
        <Box flexDirection="column">
          <Text>Mercury wants to exit strategy mode.</Text>
          <Select
            options={[
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ]}
            onChange={value => {
              if (value === 'yes') {
                setHasExitedPlanMode(true)
                setNeedsPlanModeExitAttachment(true)
                onDone()
                toolUseConfirm.onAllow({}, [
                  { type: 'setMode', mode: 'default', destination: 'session' },
                ])
              } else {
                rejectOutright()
              }
            }}
            onCancel={rejectOutright}
          />
        </Box>
      </PermissionDialog>
    )
  }

  return (
    <Box flexDirection="column">
      <PermissionDialog
        title="Ready to code?"
        color={getModeColor('strategy') as keyof Theme}
        innerPaddingX={0}
        workerBadge={workerBadge}
      >
        <Box flexDirection="column">
          <Text>Here is Mercury&apos;s plan:</Text>
          <Box
            flexDirection="column"
            borderStyle="dashed"
            borderColor="subtle"
            borderLeft={false}
            borderRight={false}
            overflow="hidden"
            {...(planCapped ? { height: planBudget + 2 } : {})}
          >
            <Box ref={planBoxRef} flexDirection="column" flexShrink={0}>
              <Markdown>{plan}</Markdown>
            </Box>
          </Box>
          {planCapped ? (
            <Text dimColor>
              … +{planHiddenRows} more line{planHiddenRows === 1 ? '' : 's'} · ctrl+f expands
            </Text>
          ) : null}
          {planExpanded ? <Text dimColor>ctrl+f collapses the preview</Text> : null}
          <PermissionRuleExplanation
            permissionResult={toolUseConfirm.permissionResult}
            toolType="tool"
          />
          {isClassifierPermissionsEnabled() && allowedPrompts && allowedPrompts.length > 0 ? (
            <Box flexDirection="column">
              <Text bold>Requested permissions</Text>
              {allowedPrompts.map((prompt, index) => (
                <Text key={index} dimColor>
                  {'  - '}
                  {prompt.tool} ({createPromptRuleContent(prompt.prompt)})
                </Text>
              ))}
            </Box>
          ) : null}
          {stickyActive ? null : (
            <Box flexDirection="column">
              <Text dimColor>
                The plan is written and Mercury is ready to execute it. Proceed?
              </Text>
              <Select
                options={options}
                onChange={value => handleChangeRef.current(value as PlanOptionValue)}
                onCancel={rejectOutright}
                onFocus={value => setRejectionFieldFocused(value === 'no')}
                onImagePaste={handleImagePaste}
                onRemoveImage={handleRemoveImage}
                pastedContents={pastedImages as never}
              />
            </Box>
          )}
        </Box>
      </PermissionDialog>
      {stickyActive ? null : editorHint}
    </Box>
  )
}

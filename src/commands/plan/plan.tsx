import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { handlePlanModeTransition } from '../../bootstrap/state.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { prepareContextForPlanMode } from '../../utils/permissions/permissionSetup.js'
import { getPlan, getPlanFilePath } from '../../utils/plans.js'
import { getExternalEditor } from '../../utils/editor.js'
import { toIDEDisplayName } from '../../utils/ide.js'
import { editFileInEditor } from '../../utils/promptEditor.js'
import { renderToString } from '../../utils/staticRender.js'
import { errorMessage } from '../../utils/errors.js'

/**
 * `/plan` — enable strategy mode, or show/open the current plan. All
 * output goes through the result channel; the node is always null.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = (args ?? '').trim()
  const currentMode = context.getAppState().toolPermissionContext.mode

  if (currentMode !== 'strategy') {
    // The strategy-mode transition hook for the current → strategy pair,
    // then the strategy-entry context preparer feeding a session-scoped mode
    // change through the permission-update applier (the EnterPlanModeTool pair).
    handlePlanModeTransition(currentMode, 'strategy')
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(prepareContextForPlanMode(prev.toolPermissionContext), {
        type: 'setMode',
        mode: 'strategy',
        destination: 'session',
      }),
    }))
    if (trimmed && trimmed !== 'open') {
      // `/plan <description>` both enables strategy mode and kicks off a turn:
      // the result-borne query option sends the same submission onward, and
      // the model's input carries the command message WITH the description.
      onDone('Entered strategy mode.', { shouldQuery: true })
      return null
    }
    onDone('Entered strategy mode.')
    return null
  }

  const plan = getPlan()
  // Runs BEFORE the `open` test: `/plan open` with no plan file reports the
  // no-plan message rather than opening an editor.
  if (plan === null || plan.trim() === '') {
    onDone('Strategy mode is already active — no plan has been written yet.')
    return null
  }

  const planPath = getPlanFilePath()
  if (trimmed.split(/\s+/)[0] === 'open') {
    try {
      await editFileInEditor(planPath)
      onDone(`Opened the plan: ${planPath}`)
    } catch (thrown) {
      onDone(`Opening the plan failed: ${errorMessage(thrown)}`)
    }
    return null
  }

  // The static block, rendered to a plain string — how local commands
  // emit multi-line output.
  const editor = getExternalEditor()
  const rendered = await renderToString(
    <Box flexDirection="column">
      <Text bold>current plan</Text>
      <Text dimColor>{planPath}</Text>
      <Text> </Text>
      <Text>{plan}</Text>
      {editor !== undefined ? (
        <>
          <Text> </Text>
          <Text dimColor>/plan open edits it in {toIDEDisplayName(editor)}</Text>
        </>
      ) : null}
    </Box>,
  )
  onDone(rendered)
  return null
}

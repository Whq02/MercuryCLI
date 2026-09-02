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

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = (args ?? '').trim()
  const currentMode = context.getAppState().toolPermissionContext.mode

  if (currentMode !== 'strategy') {
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
      onDone('Entered strategy mode.', { shouldQuery: true })
      return null
    }
    onDone('Entered strategy mode.')
    return null
  }

  const plan = getPlan()
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

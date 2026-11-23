import { requestShellBackground } from '../../tools/shell/backgroundRequest.js'
import {
  removeInterruptedMessage,
} from './resume.js'
import {
  canBatchWith,
  joinPromptValues,
} from './turnDriver.js'
import { createRunnerPorts, createRunnerState, type HeadlessOptions } from './runnerPorts.js'
import { BOOT_STEPS, runBootSteps } from './boot/bootList.js'
import { hydrateResumedRun } from './resumeHydration.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { type Tool } from '../../tools/kit/tool.js'

import { isLocalShellTask } from '../../engine/tasks/local-shell/shellTaskState.js'
import { killTask } from '../../engine/tasks/local-shell/killShellTasks.js'
import { windowsShellRoadNotice } from '../../platform/shell/windowsShellRoad.js'
import { registerBootDoors } from '../../boot/doors/registerDoors.js'


export { joinPromptValues, canBatchWith }
export { removeInterruptedMessage }

type GetAppState = () => AppState
type SetAppState = (updater: (prev: AppState) => AppState) => void


export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: GetAppState,
  setAppState: SetAppState,
  commands: import('../../commands/catalogue/commands.js').Command[],
  tools: Tool[],
  agents: AgentDefinition[],
  options: HeadlessOptions,
): Promise<void> {
  registerBootDoors()
  const { ports, give } = createRunnerPorts(
    {
      live: createRunnerState(),
      options,
      inputPrompt,
      getAppState,
      setAppState,
      commands,
      tools,
      agents,
      isLocalShellTask,
      killTask,
      requestShellBackground,
      windowsShellRoadNotice,
      hydrateResumedRun: () => hydrateResumedRun(ports),
    },
    BOOT_STEPS,
  )
  await runBootSteps(BOOT_STEPS, ports, give)
}

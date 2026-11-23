import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import {
  removeInterruptedMessage,
} from './headless/resume.js'
import {
  canBatchWith,
  joinPromptValues,
} from './headless/turnDriver.js'
import { createRunnerPorts, createRunnerState, type HeadlessOptions } from './headless/runnerPorts.js'
import { BOOT_STEPS, runBootSteps } from './headless/boot/bootList.js'
import { hydrateResumedRun } from './headless/resumeHydration.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../types/agent.js'
import { type Tool } from '../Tool.js'

import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import { killTask } from '../tasks/LocalShellTask/killShellTasks.js'
import { windowsShellRoadNotice } from '../utils/shell/windowsShellRoad.js'
import { registerBootDoors } from '../services/boot/registerDoors.js'


export { joinPromptValues, canBatchWith }
export { removeInterruptedMessage }

type GetAppState = () => AppState
type SetAppState = (updater: (prev: AppState) => AppState) => void


export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: GetAppState,
  setAppState: SetAppState,
  commands: import('../commands.js').Command[],
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

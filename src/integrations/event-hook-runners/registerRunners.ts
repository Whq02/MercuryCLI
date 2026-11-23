import { registerModelHookRunners } from '../event-hooks/runnerRegistry.js'

export function registerDefaultModelHookRunners(): void {
  registerModelHookRunners({
    runCrewmateHook: async run => {
      const { runCrewmateHook } = await import('./crewmateRunner.js')
      return runCrewmateHook(run)
    },
    runQuestionHook: async run => {
      const { runQuestionHook } = await import('./questionRunner.js')
      return runQuestionHook(run)
    },
  })
}

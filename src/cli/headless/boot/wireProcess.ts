import { noteHeadlessActivity } from '../../../utils/activityLedger.js'
import { settingsChangeDetector } from '../../../utils/settings/changeDetector.js'
import { applySettingsChange } from '../../../utils/settings/applySettingsChange.js'
import { headlessProfilerStartTurn } from '../../../utils/headlessProfiler.js'
import { noteRunPhase } from '../../../utils/runPhases.js'
import { getPerformance } from '../../../utils/profilerBase.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { startInterval } from '../../../utils/timers.js'

function run(ports: RunnerPorts): BootMade<'streamingInput'> {
  const { inputPrompt, options, setAppState } = ports
  const streamingInput = typeof inputPrompt !== 'string'
  noteHeadlessActivity(
    options.outputFormat === 'rows' && streamingInput ? 'sdk' : 'print',
  )
  settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)
  })
  if (process.versions.bun) {
    const bunGc = (globalThis as { Bun?: { gc?: (full: boolean) => void } }).Bun
    startInterval(() => bunGc?.gc?.(true), 1000).unref?.()
  }
  headlessProfilerStartTurn()
  noteRunPhase('graph_load', getPerformance().getEntriesByName('cli_entry')[0]?.startTime)
  noteRunPhase('cli_parse')
  return { streamingInput }
}

export const wireProcess: BootStep<'streamingInput'> = { name: 'wireProcess', makes: ['streamingInput'], run }

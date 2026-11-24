import { noteHeadlessActivity } from '../../../platform/logs/activityLedger.js'
import { settingsChangeDetector } from '../../../platform/settings/changeDetector.js'
import { applySettingsChange } from '../../../platform/settings/applySettingsChange.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
import { getPerformance } from '../../../platform/logs/profiling.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { startInterval } from '../../../platform/async/timers.js'

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
  noteRunPhase('graph_load', getPerformance().getEntriesByName('cli_entry')[0]?.startTime)
  noteRunPhase('cli_parse')
  return { streamingInput }
}

export const wireProcess: BootStep<'streamingInput'> = { name: 'wireProcess', makes: ['streamingInput'], run }

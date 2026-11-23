import { setAskChannel, setSessionKind } from '../../../boot/process-state/processState.js'
import { consumeSessionKindPin } from '../../concourse-workers/sessionKind.js'
import { GLYPH } from '../../../screen/theme/glyphs.js'
import { markSessionNonInteractive, markSessionBootRules } from '../../../screen/cockpit/runtimePosture.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'maxTime'> {
  const { getAppState, options } = ports
  const maxTime = options.maxTimeMs === undefined ? undefined : { limitMs: options.maxTimeMs, at: Date.now() + options.maxTimeMs }
  setAskChannel(options.door === 'wire' ? 'sdk' : 'none')
  const kindPin = consumeSessionKindPin()
  if (kindPin.kind === undefined && kindPin.raw !== undefined && kindPin.raw.trim() !== '') {
    process.stderr.write(`${GLYPH.warn} MERCURY_SESSION_KIND=${kindPin.raw} is not a session kind (the two are oculus and headless) — this run is headless\n`)
  }
  if (kindPin.kind === 'oculus' && options.door !== 'wire') {
    process.stderr.write(`${GLYPH.warn} MERCURY_SESSION_KIND=oculus names a screen, but this run has no host to carry its asks there — this run is headless\n`)
  }
  setSessionKind(kindPin.kind === 'oculus' && options.door === 'wire' ? 'oculus' : 'headless')
  markSessionNonInteractive(getAppState().toolPermissionContext?.mode)
  markSessionBootRules(getAppState().toolPermissionContext)
  return { maxTime }
}

export const markSessionPosture: BootStep<'maxTime'> = { name: 'markSessionPosture', makes: ['maxTime'], run }

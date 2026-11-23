import { installWireStdoutGuard } from '../wireStdoutGuard.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
import { loadInitialMessages } from '../resume.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import { priorTurnCount } from '../claimSession.js'
import { reconstructContentReplacementState } from '../../../engine/tool-dispatch/toolResultStorage.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<'loaded' | 'messages'>> {
  const { live, options, setAppState, wire } = ports
  if (options.outputFormat === 'rows') {
    installWireStdoutGuard()
  }
  noteRunPhase('invocation_resolution')

  const loaded = await loadInitialMessages(setAppState, {
    continue: options.continue,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: wire ? 'text' : options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })
  const messages: Message[] = loaded.messages
  live.resumeOf = loaded.resumedSessionId
  live.turnsRun = priorTurnCount(messages)
  live.contentReplacementState = reconstructContentReplacementState(messages, loaded.contentReplacements ?? [])
  return { loaded, messages }
}

export const loadSession: BootStep<'loaded' | 'messages'> = { name: 'loadSession', makes: ['loaded', 'messages'], run }

import { StructuredIO, INPUT_REFUSED_CODE, isBrokenPipeError } from '../../structuredIO.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { noticeRow } from '../../../rows/project.js'
import { DEFAULT_CAPABILITIES, checkProtocol, initializeResultOf, bindRunnerMethods } from '../runnerMethods.js'
import { type Peer, createPeer } from '../../../runner/wire/peer.js'
import { SESSION_VERBS } from '../../../runner/wire/sessionVerbs.js'
import { ndjsonSafeStringify } from '../../ndjsonSafeStringify.js'
import { logError } from '../../../utils/log.js'
import { gracefulShutdownSync } from '../../../utils/gracefulShutdown.js'
import { logForDebugging } from '../../../utils/debug.js'
import { type AskHost, createRunnerAsks, createRuleOnlyAsks } from '../runnerAsks.js'
import { registerScheduleEditDoor } from '../../../services/saturn/sessionScheduleBridge.js'
import { scheduleEditToWire } from '../../../services/engine-connector/seatWire.js'
import { registerIdeToolDoor } from '../../../services/acp/ideToolBridge.js'
import { requestFileCheckpoints } from '../../../services/changeTransaction/fileHistory.js'
import { compileJsonSchema } from '../../../services/schema/jsonSchemaEngine.js'
import { invalidParams } from '../../../runner/wire/errors.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { fileCheckpointsFact } from '../sessionFactsArm.js'
import { runnerArmsOf } from '../runnerArms.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function normalizeInputPrompt(
  inputPrompt: string | AsyncIterable<string>,
): AsyncIterable<string> {
  if (typeof inputPrompt !== 'string') return inputPrompt
  const raw = inputPrompt
  return {
    async *[Symbol.asyncIterator]() {
      if (raw.trim().length === 0) return
      yield `${jsonStringify({ type: 'prompt', content: raw })}\n`
    },
  }
}

function run(ports: RunnerPorts): BootMade<'io' | 'wire' | 'bootSettled' | 'bootReady' | 'peer' | 'asks'> {
  const { inputPrompt, live, options } = ports
  const io = new StructuredIO(normalizeInputPrompt(inputPrompt), text => ports.enqueueRow(noticeRow(ports.liveScope(), 'error', text, INPUT_REFUSED_CODE)))
  const wire = options.door === 'wire'
  live.capabilities = { ...DEFAULT_CAPABILITIES }
  let bootSettled: () => void = () => {}
  const bootReady = new Promise<void>(resolve => {
    bootSettled = resolve
  })
  const peer: Peer | null = wire
    ? createPeer({
        input: process.stdin,
        output: process.stdout,
        side: 'runner',
        serialize: message => ndjsonSafeStringify(message),
        onWriteError: error => {
          if (isBrokenPipeError(error)) io.markStdoutPipeBroken()
          else logError(error)
        },
        onDesync: badLines => {
          process.stderr.write(`mercury runner: ${badLines} consecutive unreadable lines on stdin — the stream is out of step\n`)
          gracefulShutdownSync(1)
        },
        log: logForDebugging,
      })
    : null
  const asks: AskHost = peer !== null ? createRunnerAsks(peer, () => live.capabilities) : createRuleOnlyAsks()
  if (peer !== null) {
    registerScheduleEditDoor((edit, signal) => peer.request(SESSION_VERBS.scheduleEdit.runner.name, { edit: scheduleEditToWire(edit) }, { signal }))
    registerIdeToolDoor({
      capabilities: () => ({
        readTextFile: live.capabilities.fs_read_text_file === true,
        writeTextFile: live.capabilities.fs_write_text_file === true,
        terminal: live.capabilities.terminal === true,
      }),
      readTextFile: (params, signal) => peer.request(SESSION_VERBS.fsReadTextFile.runner.name, params, signal ? { signal } : {}),
      writeTextFile: (params, signal) => peer.request(SESSION_VERBS.fsWriteTextFile.runner.name, params, signal ? { signal } : {}),
      terminalCreate: (params, signal) => peer.request(SESSION_VERBS.terminalCreate.runner.name, params, signal ? { signal } : {}),
      terminalOutput: (params, signal) => peer.request(SESSION_VERBS.terminalOutput.runner.name, params, signal ? { signal } : {}),
      terminalWaitForExit: (params, signal) => peer.request(SESSION_VERBS.terminalWaitForExit.runner.name, params, { deadlineMs: null, ...(signal ? { signal } : {}) }),
      terminalKill: (params, signal) => peer.request(SESSION_VERBS.terminalKill.runner.name, params, signal ? { signal } : {}),
      terminalRelease: (params, signal) => peer.request(SESSION_VERBS.terminalRelease.runner.name, params, signal ? { signal } : {}),
    })
    peer.onRequest(SESSION_VERBS.initialize.runner.name, async params => {
      checkProtocol(params)
      live.capabilities = params.capabilities
      if (params.file_checkpoints !== undefined) requestFileCheckpoints(params.file_checkpoints)
      await bootReady
      if (params.schema !== undefined) {
        const compiled = compileJsonSchema(params.schema)
        if (!compiled.ok) throw invalidParams(SESSION_VERBS.initialize.runner.name, [{ path: ['schema'], message: `not a JSON schema — ${compiled.error}` }])
        live.initializeJsonSchema = params.schema
      }
      return initializeResultOf(live.awaitingSessionClaim ? null : String(getSessionId()), fileCheckpointsFact())
    })
    bindRunnerMethods(peer, () => runnerArmsOf(ports))
  }
  return { io, wire, bootSettled, bootReady, peer, asks }
}

export const openWireDoor: BootStep<'io' | 'wire' | 'bootSettled' | 'bootReady' | 'peer' | 'asks'> = { name: 'openWireDoor', makes: ['io', 'wire', 'bootSettled', 'bootReady', 'peer', 'asks'], run }

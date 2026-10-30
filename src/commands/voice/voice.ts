import type { LocalCommandCall } from '../../types/command.js'
import { prepareLocalTranscriber } from '../../services/voice/transcribe.js'
import { HOLD_WORDS, NO_REPEAT_WORDS, describeVoiceStatus, setVoiceInputEnabled, toggleVoiceCapture, voiceInputEnabled } from '../../services/voice/voiceSession.js'
import { mbWords } from '../../services/voice/whisperModels.js'

let setup: Promise<string> | null = null
let setupGeneration = 0

async function turnOn(generation: number): Promise<string> {
  let prepared: Awaited<ReturnType<typeof prepareLocalTranscriber>>
  try {
    prepared = await prepareLocalTranscriber()
  } catch (error) {
    return `/voice on: ${error instanceof Error ? error.message : String(error)}`
  }
  const got = prepared.downloaded
  const downloaded = got ? `downloaded ${got.file} (${mbWords(got.bytes)}, sha256 verified) — one-time speech model download\n` : ''
  if (generation !== setupGeneration) return `${downloaded}voice input remains OFF — /voice off was requested during setup`
  const already = voiceInputEnabled()
  setVoiceInputEnabled(true)
  return `${downloaded}${already ? 'voice input already on' : `voice input ON — ${HOLD_WORDS}; the words land in the composer. ${NO_REPEAT_WORDS}`}\n${describeVoiceStatus()}`
}

export const call: LocalCommandCall = async rawArg => {
  const arg = rawArg.trim().toLowerCase()
  if (arg === '' || arg === 'capture') return { type: 'text', value: (await toggleVoiceCapture()).text }
  if (arg === 'off') {
    setupGeneration += 1
    const already = !voiceInputEnabled()
    setVoiceInputEnabled(false)
    return { type: 'text', value: already ? `voice input already off\n${describeVoiceStatus()}` : 'voice input OFF — space is a space again' }
  }
  if (arg === 'on') {
    if (setup === null) setup = turnOn(setupGeneration).finally(() => { setup = null })
    return { type: 'text', value: await setup }
  }
  return { type: 'text', value: `/voice takes on, off or capture (got "${rawArg.trim()}"); bare /voice starts or stops a capture while voice input is on` }
}

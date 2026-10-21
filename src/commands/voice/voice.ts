import type { LocalCommandCall } from '../../types/command.js'
import { localTranscriberRead } from '../../services/voice/transcribe.js'
import { HOLD_WORDS, NO_REPEAT_WORDS, describeVoiceStatus, setVoiceInputEnabled, toggleVoiceCapture, voiceInputEnabled } from '../../services/voice/voiceSession.js'
import { checkWhisperModel, downloadWhisperModel, mbWords, resolveWhisperModelPin, whisperModelsDir } from '../../services/voice/whisperModels.js'

let setup: Promise<string> | null = null
let setupGeneration = 0

async function turnOn(generation: number): Promise<string> {
  const local = localTranscriberRead()
  if (local.state === 'absent' && local.reason !== 'model') return `/voice on: ${local.note}`
  const pin = resolveWhisperModelPin()
  if (pin.kind === 'broken') return `/voice on: ${pin.note}`
  let downloaded = ''
  if (pin.kind === 'catalogue') {
    try {
      const got = await downloadWhisperModel(pin.row, whisperModelsDir())
      if (!got.reused) downloaded = `downloaded ${pin.row.file} (${mbWords(got.bytes)}, sha256 verified) — one-time speech model download\n`
    } catch (error) {
      return `/voice on: download failed — ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const model = checkWhisperModel(pin)
  if (model.state !== 'present') return `/voice on: ${model.note}`
  if (generation !== setupGeneration) return `${downloaded}voice input remains OFF — /voice off was requested during setup`
  const ready = localTranscriberRead()
  if (ready.state !== 'ok') return `/voice on: ${ready.note}`
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

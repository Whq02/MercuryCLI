import type { LocalCommandCall } from '../../types/command.js'
import { localTranscriberRead } from '../../services/voice/transcribe.js'
import { describeVoiceStatus, setVoiceInputEnabled, voiceInputEnabled } from '../../services/voice/voiceSession.js'
import { WHISPER_MODELS, checkWhisperModel, downloadWhisperModel, mbWords, resolveWhisperModelPin, whisperModelByName, whisperModelsDir } from '../../services/voice/whisperModels.js'

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`

async function download(rawName: string): Promise<string> {
  const local = localTranscriberRead()
  if (local.state === 'absent' && (local.reason === 'pack' || local.reason === 'cpu' || (local.reason === 'pin' && !local.note.startsWith('MERCURY_WHISPER_MODEL')))) {
    return `on-device transcriber: ${local.note} — the model download waits for the pack`
  }
  let row = null
  if (rawName !== '') {
    row = whisperModelByName(rawName)
    if (row === null) return `/speak download takes a model name from the catalogue (${WHISPER_MODELS.map(r => r.name).join(' · ')}); got "${rawName}"`
  } else {
    const pin = resolveWhisperModelPin()
    if (pin.kind === 'broken') return pin.note
    if (pin.kind === 'path') return `MERCURY_WHISPER_MODEL names ${pin.path}, a file already on disk — nothing to download`
    row = pin.row
  }
  const dir = whisperModelsDir()
  const present = checkWhisperModel({ kind: 'catalogue', row, pinned: true })
  if (present.state === 'present') return `${row.file} is already on disk (${mbWords(present.bytes)}) — ${present.path}\n${describeVoiceStatus()}`
  try {
    const got = await downloadWhisperModel(row, dir)
    return `downloaded ${row.file} (${mbWords(got.bytes)}, sha256 verified) into ${dir} · ${seconds(got.ms)}\n${describeVoiceStatus()}`
  } catch (error) {
    return `download failed — ${error instanceof Error ? error.message : String(error)}`
  }
}

export const call: LocalCommandCall = async rawArg => {
  const arg = rawArg.trim().toLowerCase()
  if (arg === '') return { type: 'text', value: describeVoiceStatus() }
  if (arg === 'download' || arg.startsWith('download ')) {
    return { type: 'text', value: await download(arg.slice('download'.length).trim()) }
  }
  if (arg !== 'on' && arg !== 'off') {
    return { type: 'text', value: `/speak takes on, off or download (got "${rawArg.trim()}"); bare /speak shows the status` }
  }
  const next = arg === 'on'
  if (voiceInputEnabled() === next) {
    return { type: 'text', value: `voice input already ${next ? 'on' : 'off'}\n${describeVoiceStatus()}` }
  }
  setVoiceInputEnabled(next)
  return {
    type: 'text',
    value: next
      ? `voice input ON — press space in an empty composer to start a capture, space or esc to stop; the words land in the composer\n${describeVoiceStatus()}`
      : 'voice input OFF — space is a space again',
  }
}

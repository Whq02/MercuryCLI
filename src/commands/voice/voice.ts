import type { LocalCommandCall } from '../../types/command.js'
import { toggleVoiceCapture } from '../../services/voice/voiceSession.js'

export const call: LocalCommandCall = async () => {
  const outcome = await toggleVoiceCapture()
  return { type: 'text', value: outcome.text }
}

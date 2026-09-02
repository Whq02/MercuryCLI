// ============================================================================
//  commands/voice/voice.ts — `/voice`: start a capture, or stop the one
//  running. The composer's `v` and this command share ONE action
//  (toggleVoiceCapture); the receipt is the action's own words.
// ============================================================================
import type { LocalCommandCall } from '../../types/command.js'
import { toggleVoiceCapture } from '../../services/voice/voiceSession.js'

export const call: LocalCommandCall = async () => {
  const outcome = await toggleVoiceCapture()
  return { type: 'text', value: outcome.text }
}

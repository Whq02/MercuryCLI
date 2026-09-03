// ============================================================================
//  commands/speak/speak.ts — `/speak [on|off]`: the voice-input master
//  toggle, persisted. Bare `/speak` answers the status: the toggle, the
//  capture backend and the transcribing sign-in the next take would use.
// ============================================================================
import type { LocalCommandCall } from '../../types/command.js'
import { describeVoiceStatus, setVoiceInputEnabled, voiceInputEnabled } from '../../services/voice/voiceSession.js'

export const call: LocalCommandCall = async rawArg => {
  const arg = rawArg.trim().toLowerCase()
  if (arg === '') return { type: 'text', value: describeVoiceStatus() }
  if (arg !== 'on' && arg !== 'off') {
    return { type: 'text', value: `/speak takes on or off (got "${rawArg.trim()}"); bare /speak shows the status` }
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

import {
  implementerModeEnabled,
  isImplementerRole,
  scribeChatroomEnabled,
} from './scribeGates.js'

export function buildImplementerAwarenessReminder(_messages: readonly unknown[]): string {
  if (!(implementerModeEnabled() && isImplementerRole())) return ''

  const chatroom = scribeChatroomEnabled()

  const parts: string[] = [
    'Your turn produces AT MOST ONE bus message: a single `progress` OR a single `escalate`, never both and never ' +
      'two progress lines. Batch this turn’s phase-status into that one line; a turn with nothing new sends NOTHING ' +
      '(silent work between checkpoints is correct). An escalate REPLACES the progress that turn — it never stacks on it.',
    chatroom
      ? 'You have NO inbound operator channel and cannot be addressed directly: prose you type into your turn is seen ' +
        'by NO ONE. But your `SendMessage` envelope renders DIRECTLY to the operator as a `[Mercury-Implement]` line ' +
        '(and to the Scribe) — so write each one so the operator reads it as-is; put what matters there, and never ' +
        'assume typed prose was read.'
      : 'You have NO operator channel and NO chat: prose you type into your turn is seen by NO ONE. ONLY your ' +
        '`SendMessage` envelope reaches the Scribe (who relays to the operator). So put what matters in the one ' +
        'envelope — never assume typed prose was read.',
    'A SEND is WRITTEN to the bus; it is NOT proof the Scribe received or acted on it. Do NOT re-send the same ' +
      'status, and never narrate or invent the Scribe’s reply — if nothing has come back, nothing has come back.',
    'A respawn / fresh transcript is NORMAL (the supervisor restarts or reconfigures you) — re-orient from disk and ' +
      'your inbox, and do NOT re-narrate or re-send a status you may have already sent before the restart. (This is ' +
      'about your OWN progress messages; the at-least-once EXECUTION dedup of dispatched work is separate.)',
  ]
  return parts.join('\n\n')
}

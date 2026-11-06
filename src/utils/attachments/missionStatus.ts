import type { Attachment } from './types.js'

export function getMissionStatusAttachment(messages: readonly unknown[] = []): Attachment[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const guard = require('../../guards/mission.js') as typeof import('../../guards/mission.js')
  const mission = guard.getActiveMission()
  if (mission === undefined || mission.met) return []
  const text = guard.missionStatusLine(mission)
  if (statusAlreadyThisTurn(messages, text)) return []
  return [
    {
      type: 'mission_status',
      text,
      checks: mission.iterations,
      state: mission.paused === undefined ? 'armed' : 'paused',
      ...(mission.verdict === undefined ? {} : { verdict: mission.verdict.kind }),
    },
  ]
}

function statusAlreadyThisTurn(messages: readonly unknown[], text: string): boolean {
  const rows = messages as ReadonlyArray<{ type?: string; isMeta?: boolean; toolUseResult?: unknown; attachment?: { type?: string; text?: string } }>
  const boundary = rows.findLastIndex(row => row?.type === 'user' && !row.isMeta && !row.toolUseResult)
  for (let i = rows.length - 1; i > boundary; i--) {
    const row = rows[i]
    if (row?.type === 'attachment' && row.attachment?.type === 'mission_status' && row.attachment.text === text) return true
  }
  return false
}
